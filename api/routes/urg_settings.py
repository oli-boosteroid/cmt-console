"""Urgent Request form settings: one admin switch for Verification tickets."""
import logging

from flask import Blueprint, jsonify, request

from api.routes.console_db import sync_db
from api.routes.console_auth import admin_required, current_user, login_required

logger = logging.getLogger(__name__)

urg_settings_bp = Blueprint("urg_settings", __name__, url_prefix="/api/console")


def _urg_verification_on() -> bool:
    return bool(((sync_db["console_config"].find_one({"key": "urg_verification"}) or {}).get("value") or {}).get("enabled"))


@urg_settings_bp.route("/urg-settings", methods=["GET"])
@login_required
def urg_settings():
    """Urgent Request form: are Verification tickets (and the Jira ticket type field) switched on."""
    return jsonify({"verification": _urg_verification_on()}), 200


@urg_settings_bp.route("/admin/urg-settings", methods=["POST"])
@admin_required
def urg_settings_set():
    """One admin switch: the console offers Verification and the bot sets the URG ticket type field."""
    on = bool((request.get_json(silent=True) or {}).get("verification"))
    sync_db["console_config"].update_one({"key": "urg_verification"},
                                         {"$set": {"key": "urg_verification", "value": {"enabled": on}}}, upsert=True)
    u = current_user() or {}
    logger.info("[URG] %s turned Verification tickets %s", u.get("name") or u.get("email", "?"), "on" if on else "off")
    return jsonify({"verification": on}), 200
