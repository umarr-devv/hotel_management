# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Общие помощники приложения."""

import frappe


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
