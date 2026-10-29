"""
Cram mode for grammar flashcards (Bunpro-style).

Design rule: cram NEVER writes to the `grammars` flashcard collection.
Normal reviews call POST /f-api/v1/flashcard, which overwrites `difficulty`.
Cram only reads that collection and writes finished sessions to `cramSessions`.

Routes (all under /f-api/v1):
  POST /cram/build     -> shuffled list of grammar cards for a session
  POST /cram/session   -> save a finished session
  GET  /cram/stats     -> recent sessions + titles missed in the last session
"""

import logging
import os
import random
from datetime import datetime, timezone

import requests
from flask import jsonify, request
from pymongo import MongoClient

logger = logging.getLogger(__name__)

VALID_P_TAGS = {"JLPT_N5", "JLPT_N4", "JLPT_N3", "JLPT_N2", "JLPT_N1"}
VALID_FILTERS = {"all", "unknown", "hard", "not_easy", "missed_last_session"}
VALID_MODES = {"reading", "listening"}
DEFAULT_LIMIT = 20
MAX_LIMIT = 200


class CramModule:
    def register_routes(self, app):
        # Same Mongo instance / database that flashcards.py uses.
        mongo = MongoClient("mongodb://localhost:27017/")
        db = mongo["flaskFlashcardDB"]
        grammars = db["grammars"]
        sessions = db["cramSessions"]

        env = os.getenv("APP_ENV", "dev")
        host = "express-db" if env == "prod" else "localhost"
        port = 8000

        # ------------------------------------------------------------------
        # helpers
        # ------------------------------------------------------------------
        def fetch_static_grammars(p_tag):
            url = f"http://{host}:{port}/e-api/v1/grammars?p_tag={p_tag}"
            resp = requests.get(url, timeout=15)
            resp.raise_for_status()
            return resp.json().get("grammars", [])

        def last_session_missed(user_id):
            """Set of (p_tag, title) missed in the user's most recent session."""
            last = sessions.find_one({"userId": user_id}, sort=[("startedAt", -1)])
            if not last:
                return set()
            return {
                (i["p_tag"], i["title"])
                for i in last.get("items", [])
                if i.get("wrong", 0) > 0
            }

        # ------------------------------------------------------------------
        # POST /cram/build
        # ------------------------------------------------------------------
        @app.route("/f-api/v1/cram/build", methods=["POST"])
        def cram_build():
            data = request.get_json(silent=True) or {}
            user_id = data.get("userId")
            p_tags = [t for t in data.get("p_tags", []) if t in VALID_P_TAGS]
            flt = data.get("filter", "all")
            try:
                limit = int(data.get("limit", DEFAULT_LIMIT))
            except (TypeError, ValueError):
                limit = DEFAULT_LIMIT
            limit = max(1, min(limit, MAX_LIMIT))

            if not user_id or not p_tags:
                return jsonify({"error": "userId and at least one valid p_tag required"}), 400
            if flt not in VALID_FILTERS:
                return jsonify({"error": f"filter must be one of {sorted(VALID_FILTERS)}"}), 400

            try:
                # User's saved difficulty per card (read-only).
                difficulty = {}
                for doc in grammars.find({"userId": user_id, "p_tag": {"$in": p_tags}}):
                    difficulty[(doc.get("p_tag"), doc.get("title"))] = doc.get("difficulty", "unknown")

                missed = last_session_missed(user_id) if flt == "missed_last_session" else set()

                items = []
                for p_tag in p_tags:
                    for g in fetch_static_grammars(p_tag):
                        key = (g.get("p_tag", p_tag), g.get("title"))
                        diff = difficulty.get(key, "unknown")
                        if flt == "unknown" and diff != "unknown":
                            continue
                        if flt == "hard" and diff != "hard":
                            continue
                        if flt == "not_easy" and diff == "easy":
                            continue
                        if flt == "missed_last_session" and key not in missed:
                            continue
                        if not g.get("examples"):
                            continue  # nothing to quiz on
                        items.append(
                            {
                                "title": g.get("title"),
                                "p_tag": g.get("p_tag", p_tag),
                                "s_tag": g.get("s_tag"),
                                "short_explanation": g.get("short_explanation", ""),
                                "long_explanation": g.get("long_explanation", ""),
                                "formation": g.get("formation", ""),
                                "examples": g["examples"],
                                "difficulty": diff,
                            }
                        )

                random.shuffle(items)  # unweighted, unlike the normal review
                items = items[:limit]
                return jsonify({"items": items, "count": len(items)}), 200

            except requests.RequestException as e:
                logger.error("cram_build: static data fetch failed: %s", e)
                return jsonify({"error": "Failed to fetch grammar data"}), 502
            except Exception as e:
                logger.exception("cram_build failed")
                return jsonify({"error": str(e)}), 500

        # ------------------------------------------------------------------
        # POST /cram/session
        # ------------------------------------------------------------------
        @app.route("/f-api/v1/cram/session", methods=["POST"])
        def cram_session_save():
            data = request.get_json(silent=True) or {}
            user_id = data.get("userId")
            mode = data.get("mode")
            raw_items = data.get("items", [])

            if not user_id or mode not in VALID_MODES or not isinstance(raw_items, list) or not raw_items:
                return jsonify({"error": "userId, mode and a non-empty items list required"}), 400

            items = []
            for i in raw_items:
                try:
                    items.append(
                        {
                            "p_tag": str(i["p_tag"]),
                            "title": str(i["title"]),
                            "correct": int(i.get("correct", 0)),
                            "wrong": int(i.get("wrong", 0)),
                        }
                    )
                except (KeyError, TypeError, ValueError):
                    return jsonify({"error": "each item needs p_tag, title, correct, wrong"}), 400

            doc = {
                "userId": user_id,
                "mode": mode,
                "filter": data.get("filter", "all"),
                "p_tags": data.get("p_tags", []),
                "startedAt": datetime.now(timezone.utc),
                "items": items,
                "totals": {
                    "cards": len(items),
                    "first_try": sum(1 for i in items if i["wrong"] == 0),
                    "missed": sum(1 for i in items if i["wrong"] > 0),
                    "attempts": sum(i["correct"] + i["wrong"] for i in items),
                },
            }
            try:
                result = sessions.insert_one(doc)
                return jsonify({"message": "Session saved", "id": str(result.inserted_id)}), 201
            except Exception as e:
                logger.exception("cram_session_save failed")
                return jsonify({"error": str(e)}), 500

        # ------------------------------------------------------------------
        # GET /cram/stats?userId=...
        # ------------------------------------------------------------------
        @app.route("/f-api/v1/cram/stats", methods=["GET"])
        def cram_stats():
            user_id = request.args.get("userId")
            if not user_id:
                return jsonify({"error": "userId required"}), 400
            try:
                recent = []
                for s in sessions.find({"userId": user_id}).sort("startedAt", -1).limit(20):
                    recent.append(
                        {
                            "id": str(s["_id"]),
                            "startedAt": s["startedAt"].isoformat(),
                            "mode": s.get("mode"),
                            "filter": s.get("filter"),
                            "p_tags": s.get("p_tags", []),
                            "totals": s.get("totals", {}),
                        }
                    )
                missed = sorted(last_session_missed(user_id))
                return jsonify(
                    {
                        "sessions": recent,
                        "missed_last_session": [{"p_tag": p, "title": t} for p, t in missed],
                    }
                ), 200
            except Exception as e:
                logger.exception("cram_stats failed")
                return jsonify({"error": str(e)}), 500
