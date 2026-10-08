# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Общие помощники приложения."""

import math
import re

import frappe
from frappe.utils import cint, flt


def get_disabled_room_types():
	"""Имена отключённых типов номеров."""
	return frappe.get_all("Room Type", filters={"disabled": 1}, pluck="name")


def active_room_filters():
	"""Фильтры Hotel Room: только включённые номера включённых типов."""
	filters = [["disabled", "=", 0]]
	disabled_types = get_disabled_room_types()
	if disabled_types:
		filters.append(["room_type", "not in", disabled_types])
	return filters


def is_room_active(room):
	"""Номер включён, и его тип номера тоже включён."""
	values = frappe.db.get_value("Hotel Room", room, ["disabled", "room_type"], as_dict=True)
	if not values or values.disabled:
		return False
	return not (values.room_type and frappe.db.get_value("Room Type", values.room_type, "disabled"))


def hours_to_days(hours):
	"""Оплачиваемые сутки брони: часы / 24 с округлением вверх (25 ч — 2 суток)."""
	return math.ceil(flt(hours) / 24) if flt(hours) > 0 else 0


def natural_key(value):
	"""Ключ «естественной» сортировки: «2» раньше «10», регистр не важен."""
	return [cint(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value or "")]


def room_number_key(room):
	"""Сортировка номеров по самому номеру: «№7», «7», «VIP 7» → 7."""
	return natural_key(re.sub(r"^\D+", "", room.room_number or room.name))
