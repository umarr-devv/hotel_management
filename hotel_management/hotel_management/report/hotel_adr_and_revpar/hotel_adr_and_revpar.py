# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""ADR и RevPAR — ключевые показатели доходности номерного фонда.

  ADR     = выручка от проживания / проданные номеро-сутки
  RevPAR  = выручка от проживания / доступные номеро-сутки
  TRevPAR = вся выручка (проживание + услуги) / доступные номеро-сутки

Выручка брони, выходящей за границы периода, делится пропорционально часам.
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

	stats, _rooms, _bookings = build_daily_stats(filters, from_date, to_date, group_by)

	rows = []
	for key in sort_group_keys(stats, group_by):
		group = stats[key]
		available = group.available_room_days
		occupied = len(group.occupied_room_days)
		total_revenue = group.room_revenue + group.service_revenue
		rows.append(
			{
				"group_value": key,
				"occupied_room_days": occupied,
				"available_room_days": available,
				"occupancy": flt(percent(occupied, available), 2),
				"room_revenue": flt(group.room_revenue, 2),
				"adr": flt(group.room_revenue / occupied, 2) if occupied else 0,
				"revpar": flt(group.room_revenue / available, 2) if available else 0,
				"rate_per_hour": flt(group.room_revenue / group.occupied_hours, 2)
				if group.occupied_hours
				else 0,
				"service_revenue": flt(group.service_revenue, 2),
				"total_revenue": flt(total_revenue, 2),
				"trevpar": flt(total_revenue / available, 2) if available else 0,
			}
		)

	return get_columns(group_by), rows, None, get_chart(rows), get_report_summary(rows)


def get_chart(rows):
	if not rows:
		return None
	return {
		"data": {
			"labels": [str(row["group_value"]) for row in rows],
			"datasets": [
				{"name": _("ADR"), "values": [row["adr"] for row in rows]},
				{"name": _("RevPAR"), "values": [row["revpar"] for row in rows]},
			],
		},
		"type": "bar",
		"fieldtype": "Currency",
	}


def get_report_summary(rows):
	occupied = sum(row["occupied_room_days"] for row in rows)
	available = sum(row["available_room_days"] for row in rows)
	room_revenue = sum(row["room_revenue"] for row in rows)
	total_revenue = sum(row["total_revenue"] for row in rows)
	return [
		{
			"label": _("ADR"),
			"value": flt(room_revenue / occupied, 2) if occupied else 0,
			"datatype": "Currency",
			"indicator": "Blue",
		},
		{
			"label": _("RevPAR"),
			"value": flt(room_revenue / available, 2) if available else 0,
			"datatype": "Currency",
			"indicator": "Green",
		},
		{
			"label": _("Occupancy"),
			"value": flt(percent(occupied, available), 2),
			"datatype": "Percent",
		},
		{"label": _("Total Revenue"), "value": flt(total_revenue, 2), "datatype": "Currency"},
	]


def get_columns(group_by):
	return [
		group_column(group_by),
		{
			"fieldname": "occupied_room_days",
			"label": _("Room Days Sold"),
			"fieldtype": "Int",
			"width": 130,
		},
		{
			"fieldname": "available_room_days",
			"label": _("Room Days Available"),
			"fieldtype": "Int",
			"width": 150,
		},
		{"fieldname": "occupancy", "label": _("Occupancy %"), "fieldtype": "Percent", "width": 120},
		{
			"fieldname": "room_revenue",
			"label": _("Room Revenue"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{"fieldname": "adr", "label": _("ADR"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "revpar", "label": _("RevPAR"), "fieldtype": "Currency", "width": 120},
		{
			"fieldname": "rate_per_hour",
			"label": _("Avg Rate / Hour"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{
			"fieldname": "service_revenue",
			"label": _("Services Revenue"),
			"fieldtype": "Currency",
			"width": 150,
		},
		{
			"fieldname": "total_revenue",
			"label": _("Total Revenue"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{"fieldname": "trevpar", "label": _("TRevPAR"), "fieldtype": "Currency", "width": 120},
	]
