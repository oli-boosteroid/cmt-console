"""
Admin > Data > Database maintenance: the numbered migration steps (services/db_migrations.py).

  GET  /api/console/admin/db-migrations           -> every step with its status
  GET  /api/console/admin/db-report               -> step 0: a read-only report of every collection
  POST /api/console/admin/db-migrations/<id>      {"apply": false} = Preview (counts only),
                                                  {"apply": true}  = Apply (deletes; cannot be undone)
"""
import logging
import threading

from flask import Blueprint, jsonify, request

from api.routes.console_db import sync_db
from api.routes.console_auth import admin_required, current_user
from services import db_migrations

logger = logging.getLogger(__name__)
admin_db_bp = Blueprint("admin_db", __name__, url_prefix="/api/console")
_apply_lock = threading.Lock()     # two admins pressing Apply at once run the step once


@admin_db_bp.route("/admin/db-migrations", methods=["GET"])
@admin_required
def db_migrations_list():
    return jsonify({"steps": db_migrations.status(sync_db)}), 200


@admin_db_bp.route("/admin/db-report", methods=["GET"])
@admin_required
def db_report():
    return jsonify(db_migrations.report(sync_db)), 200


@admin_db_bp.route("/admin/db-migrations/<int:step_id>", methods=["POST"])
@admin_required
def db_migration_run(step_id):
    apply = bool((request.get_json(silent=True) or {}).get("apply"))
    u = current_user() or {}
    who = u.get("name") or u.get("email", "?")
    if not apply:
        res, err = db_migrations.run_manual(sync_db, step_id, False, who)
    else:
        if not _apply_lock.acquire(blocking=False):
            return jsonify({"error": "Another step is being applied right now"}), 409
        try:
            res, err = db_migrations.run_manual(sync_db, step_id, True, who)
        except Exception as e:
            logger.error("[DBMigrations] step %s failed: %s", step_id, e, exc_info=True)
            return jsonify({"error": "The step failed: %s" % e}), 500
        finally:
            _apply_lock.release()
    if err:
        return jsonify({"error": err}), 400
    return jsonify(res), 200
