# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Загрузка номерного фонда.

Номеро-сутки: номер считается занятым в дате, если бронь пересекает эти сутки
хотя бы на час. Дополнительно считается загрузка по часам — она честнее для
почасовых броней (номер, занятый на 3 часа, не равен занятому на сутки).
"""

import frappe
from frappe import _
from frappe.utils import flt

from hotel_management.hotel_management.report.report_utils import (
	build_daily_stats,
	get_period,
	group_column,
	percent,
	sort_group_keys,
)


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=30)
	group_by = filters.get("group_by") or "Date"

	stats, rooms, _bookings = build_daily_stats(filters, from_date, to_date, group_by)

	if not rooms:
		frappe.msgprint(_("No rooms match the filters"))

	rows = []
	for key in sort_group_keys(stats, group_by):
		group = stats[key]
		available = group.available_room_days
		occupied = len(group.occupied_room_days)
		rows.append(
			{
				"group_value": key,
				"available_room_days": available,
				"occupied_room_days": occupied,
				"occupancy": flt(percent(occupied, available), 2),
				"occupied_hours": flt(group.occupied_hours, 1),
				"hours_occupancy": flt(percent(group.occupied_hours, available * 24), 2),
				"bookings": len(group.bookings),
				"room_revenue": flt(group.room_revenue, 2),
			}
		)

	return get_columns(group_by), rows, None, get_chart(rows, group_by), get_report_summary(rows)


def get_chart(rows, group_by):
	if not rows:
		return None
	return {
		"data": {
			"labels": [str(row["group_value"]) for row in rows],
			"datasets": [{"name": _("Occupancy %"), "values": [row["occupancy"] for row in rows]}],
		},
		"type": "line" if group_by in ("Date", "Month") else "bar",
		"fieldtype": "Float",
	}


def get_report_summary(rows):
	available = sum(row["available_room_days"] for row in rows)
	occupied = sum(row["occupied_room_days"] for row in rows)
	hours = sum(row["occupied_hours"] for row in rows)
	return [
		{
			"label": _("Occupancy"),
			"value": flt(percent(occupied, available), 2),
			"datatype": "Percent",
			"indicator": "Green" if percent(occupied, available) >= 50 else "Orange",
		},
		{"label": _("Occupied Room Days"), "value": occupied, "datatype": "Int"},
		{"label": _("Available Room Days"), "value": available, "datatype": "Int"},
		{"label": _("Occupied Hours"), "value": flt(hours, 1), "datatype": "Float"},
	]


def get_columns(group_by):
	return [
		group_column(group_by),
		{
			"fieldname": "occupied_room_days",
			"label": _("Occupied Room Days"),
			"fieldtype": "Int",
			"width": 150,
		},
		{
			"fieldname": "available_room_days",
			"label": _("Available Room Days"),
			"fieldtype": "Int",
			"width": 150,
		},
		{"fieldname": "occupancy", "label": _("Occupancy %"), "fieldtype": "Percent", "width": 120},
		{
			"fieldname": "occupied_hours",
			"label": _("Occupied Hours"),
			"fieldtype": "Float",
			"width": 130,
		},
		{
			"fieldname": "hours_occupancy",
			"label": _("Hourly Occupancy %"),
			"fieldtype": "Percent",
			"width": 150,
		},
		{"fieldname": "bookings", "label": _("Bookings"), "fieldtype": "Int", "width": 100},
		{
			"fieldname": "room_revenue",
			"label": _("Room Revenue"),
			"fieldtype": "Currency",
			"width": 140,
		},
	]
