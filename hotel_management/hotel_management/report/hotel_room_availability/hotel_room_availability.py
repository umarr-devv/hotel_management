# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Свободные номера на период — табличная версия шахматки.

Для каждого номера считается, сколько часов периода он занят бронями.
Статус: Free — броней нет, Fully Booked — занят весь период, иначе Partially Booked.
"""

import frappe
from frappe import _
from frappe.utils import flt, get_datetime

from hotel_management.hotel_management.report.report_utils import (
	get_bookings,
	get_period,
	get_rooms,
	overlap_hours,
	percent,
	period_bounds,
)

FREE = "Free"
PARTIAL = "Partially Booked"
FULL = "Fully Booked"


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=0)
	availability = filters.get("availability") or "All"

	period_start, period_end = period_bounds(from_date, to_date)
	period_hours = (period_end - period_start).total_seconds() / 3600.0

	rooms = get_rooms(filters)
	bookings_by_room = {}
	for booking in get_bookings(filters, from_date, to_date):
		bookings_by_room.setdefault(booking.room, []).append(booking)

	rows = []
	for room in rooms:
		row = make_row(room, bookings_by_room.get(room.name, []), period_start, period_end, period_hours)
		if availability != "All" and row["status"] != availability:
			continue
		rows.append(row)

	rows.sort(key=lambda row: (row["booked_hours"], str(row["room"])))

	return get_columns(), rows, None, None, get_report_summary(rows, rooms)


def make_row(room, bookings, period_start, period_end, period_hours):
	booked_hours = 0.0
	next_check_in = None
	guest = None

	for booking in bookings:
		booked_hours += overlap_hours(booking.check_in, booking.check_out, period_start, period_end)
		check_in = get_datetime(booking.check_in)
		if check_in >= period_start and (next_check_in is None or check_in < next_check_in):
			next_check_in = check_in
		if guest is None:
			guest = booking.customer

	free_hours = max(period_hours - booked_hours, 0.0)

	if booked_hours <= 0:
		status = FREE
	elif free_hours < 0.01:
		status = FULL
	else:
		status = PARTIAL

	return {
		"room": room.name,
		"room_type": room.room_type,
		"hotel_building": room.hotel_building,
		"hotel_floor": room.hotel_floor,
		"status": status,
		"booked_hours": flt(booked_hours, 1),
		"free_hours": flt(free_hours, 1),
		"occupancy": flt(percent(booked_hours, period_hours), 2),
		"bookings": len(bookings),
		"next_check_in": next_check_in,
		"guest": guest,
	}


def get_report_summary(rows, rooms):
	free = len([row for row in rows if row["status"] == FREE])
	full = len([row for row in rows if row["status"] == FULL])
	partial = len([row for row in rows if row["status"] == PARTIAL])
	return [
		{"label": _("Rooms"), "value": len(rooms), "datatype": "Int"},
		{"label": _("Free"), "value": free, "datatype": "Int", "indicator": "Green"},
		{"label": _("Partially Booked"), "value": partial, "datatype": "Int", "indicator": "Orange"},
		{"label": _("Fully Booked"), "value": full, "datatype": "Int", "indicator": "Red"},
	]


def get_columns():
	return [
		{
			"fieldname": "room",
			"label": _("Room"),
			"fieldtype": "Link",
			"options": "Hotel Room",
			"width": 160,
		},
		{
			"fieldname": "room_type",
			"label": _("Room Type"),
			"fieldtype": "Link",
			"options": "Room Type",
			"width": 130,
		},
		{
			"fieldname": "hotel_building",
			"label": _("Building"),
			"fieldtype": "Link",
			"options": "Hotel Building",
			"width": 130,
		},
		{
			"fieldname": "hotel_floor",
			"label": _("Floor"),
			"fieldtype": "Link",
			"options": "Hotel Floor",
			"width": 130,
		},
		{"fieldname": "status", "label": _("Availability"), "fieldtype": "Data", "width": 140},
		{"fieldname": "free_hours", "label": _("Free Hours"), "fieldtype": "Float", "width": 110},
		{"fieldname": "booked_hours", "label": _("Booked Hours"), "fieldtype": "Float", "width": 120},
		{"fieldname": "occupancy", "label": _("Occupancy %"), "fieldtype": "Percent", "width": 120},
		{"fieldname": "bookings", "label": _("Bookings"), "fieldtype": "Int", "width": 100},
		{
			"fieldname": "next_check_in",
			"label": _("Next Check In"),
			"fieldtype": "Datetime",
			"width": 165,
		},
		{
			"fieldname": "guest",
			"label": _("Guest"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 170,
		},
	]
