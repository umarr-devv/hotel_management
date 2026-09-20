# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Выручка бронирований в разрезе типов номеров, тарифов, корпусов и гостей.

Суммы берутся из броней; если бронь выходит за границы периода, её выручка
делится пропорционально часам, попавшим в период.
"""

import frappe
from frappe import _
from frappe.utils import flt

from hotel_management.hotel_management.report.report_utils import (
	daterange,
	day_bounds,
	get_bookings,
	get_period,
	overlap_hours,
	percent,
	period_bounds,
	revenue_share,
)

GROUP_FIELDS = {
	"Room Type": ("room_type", "Room Type"),
	"Room Rate": ("room_rate", "Room Rate"),
	"Hotel Building": ("hotel_building", "Hotel Building"),
	"Hotel Floor": ("hotel_floor", "Hotel Floor"),
	"Room": ("room", "Hotel Room"),
	"Customer": ("customer", "Customer"),
}


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=30)
	group_by = filters.get("group_by") or "Room Type"

	if group_by not in GROUP_FIELDS:
		frappe.throw(_("Unsupported Group By: {0}").format(group_by))

	field, link_doctype = GROUP_FIELDS[group_by]
	period_start, period_end = period_bounds(from_date, to_date)

	groups = {}
	for booking in get_bookings(filters, from_date, to_date):
		hours = overlap_hours(booking.check_in, booking.check_out, period_start, period_end)
		if not hours:
			continue

		room_revenue, service_revenue = revenue_share(booking, hours)
		group = groups.setdefault(
			booking.get(field) or _("Not Set"),
			frappe._dict(bookings=0, room_days=0, hours=0.0, room_revenue=0.0, service_revenue=0.0),
		)
		group.bookings += 1
		group.hours += hours
		group.room_days += count_room_days(booking, from_date, to_date)
		group.room_revenue += room_revenue
		group.service_revenue += service_revenue

	total_revenue = sum(group.room_revenue + group.service_revenue for group in groups.values())

	rows = []
	for key, group in groups.items():
		revenue = group.room_revenue + group.service_revenue
		rows.append(
			{
				"group_value": key,
				"bookings": group.bookings,
				"room_days": group.room_days,
				"hours": flt(group.hours, 1),
				"room_revenue": flt(group.room_revenue, 2),
				"service_revenue": flt(group.service_revenue, 2),
				"total_revenue": flt(revenue, 2),
				"rate_per_hour": flt(group.room_revenue / group.hours, 2) if group.hours else 0,
				"adr": flt(group.room_revenue / group.room_days, 2) if group.room_days else 0,
				"share": flt(percent(revenue, total_revenue), 2),
			}
		)

	rows.sort(key=lambda row: row["total_revenue"], reverse=True)

	return (
		get_columns(group_by, link_doctype),
		rows,
		None,
		get_chart(rows),
		get_report_summary(rows),
	)


def count_room_days(booking, from_date, to_date):
	"""Сколько суток периода бронь занимала номер."""
	days = 0
	for day in daterange(from_date, to_date):
		start, end = day_bounds(day)
		if overlap_hours(booking.check_in, booking.check_out, start, end):
			days += 1
	return days


def get_chart(rows):
	if not rows:
		return None
	top = rows[:10]
	return {
		"data": {
			"labels": [str(row["group_value"]) for row in top],
			"datasets": [
				{"name": _("Room Revenue"), "values": [row["room_revenue"] for row in top]},
				{"name": _("Services Revenue"), "values": [row["service_revenue"] for row in top]},
			],
		},
		"type": "bar",
		"barOptions": {"stacked": 1},
		"fieldtype": "Currency",
	}


def get_report_summary(rows):
	return [
		{
			"label": _("Total Revenue"),
			"value": sum(row["total_revenue"] for row in rows),
			"datatype": "Currency",
			"indicator": "Green",
		},
		{
			"label": _("Room Revenue"),
			"value": sum(row["room_revenue"] for row in rows),
			"datatype": "Currency",
		},
		{
			"label": _("Services Revenue"),
			"value": sum(row["service_revenue"] for row in rows),
			"datatype": "Currency",
		},
		{"label": _("Bookings"), "value": sum(row["bookings"] for row in rows), "datatype": "Int"},
	]


def get_columns(group_by, link_doctype):
	return [
		{
			"fieldname": "group_value",
			"label": _(group_by),
			"fieldtype": "Link",
			"options": link_doctype,
			"width": 180,
		},
		{"fieldname": "bookings", "label": _("Bookings"), "fieldtype": "Int", "width": 100},
		{"fieldname": "room_days", "label": _("Room Days"), "fieldtype": "Int", "width": 110},
		{"fieldname": "hours", "label": _("Hours"), "fieldtype": "Float", "width": 100},
		{
			"fieldname": "room_revenue",
			"label": _("Room Revenue"),
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
		{
			"fieldname": "rate_per_hour",
			"label": _("Avg Rate / Hour"),
			"fieldtype": "Currency",
			"width": 140,
		},
		{"fieldname": "adr", "label": _("ADR"), "fieldtype": "Currency", "width": 120},
		{"fieldname": "share", "label": _("Share %"), "fieldtype": "Percent", "width": 110},
	]
