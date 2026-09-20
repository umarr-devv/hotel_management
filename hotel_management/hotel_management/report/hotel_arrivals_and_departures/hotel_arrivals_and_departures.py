# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Заезды, выезды и проживающие — ежедневный отчёт ресепшена.

Одна бронь может попасть в отчёт несколькими строками: например, почасовая
бронь внутри одних суток — это и заезд, и выезд.
"""

import frappe
from frappe import _
from frappe.utils import flt, getdate

from hotel_management.hotel_management.report.report_utils import (
	booking_hours,
	get_bookings,
	get_period,
	stay_nights,
)

ARRIVAL = "Arrival"
DEPARTURE = "Departure"
IN_HOUSE = "In House"
MOVEMENT_ORDER = {ARRIVAL: 0, DEPARTURE: 1, IN_HOUSE: 2}


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=0)
	movement = filters.get("movement") or "All"

	rows = []
	counts = {ARRIVAL: 0, DEPARTURE: 0, IN_HOUSE: 0}

	for booking in get_bookings(filters, from_date, to_date):
		for kind in get_movements(booking, from_date, to_date):
			counts[kind] += 1
			if movement in ("All", kind):
				rows.append(make_row(booking, kind))

	rows.sort(key=lambda row: (MOVEMENT_ORDER[row["movement"]], row["check_in"]))

	return get_columns(), rows, None, None, get_report_summary(counts, rows)


def get_movements(booking, from_date, to_date):
	"""Чем бронь является в этом периоде: заездом, выездом или проживанием."""
	movements = []
	if from_date <= getdate(booking.check_in) <= to_date:
		movements.append(ARRIVAL)
	if from_date <= getdate(booking.check_out) <= to_date:
		movements.append(DEPARTURE)
	if not movements:
		# бронь началась раньше периода и закончится позже — гость просто живёт
		movements.append(IN_HOUSE)
	return movements


def make_row(booking, movement):
	return {
		"movement": movement,
		"booking": booking.name,
		"status": booking.status,
		"customer": booking.customer,
		"room": booking.room,
		"room_type": booking.room_type,
		"hotel_building": booking.hotel_building,
		"check_in": booking.check_in,
		"check_out": booking.check_out,
		"nights": stay_nights(booking.check_in, booking.check_out),
		"hours": flt(booking_hours(booking), 2),
		"total_amount": flt(booking.total_amount),
		"pay_status": booking.pay_status,
	}


def get_report_summary(counts, rows):
	return [
		{"label": _("Arrivals"), "value": counts[ARRIVAL], "indicator": "Green", "datatype": "Int"},
		{"label": _("Departures"), "value": counts[DEPARTURE], "indicator": "Orange", "datatype": "Int"},
		{"label": _("In House"), "value": counts[IN_HOUSE], "indicator": "Blue", "datatype": "Int"},
		{
			"label": _("Amount Shown"),
			"value": sum(flt(row["total_amount"]) for row in rows),
			"datatype": "Currency",
		},
	]


def get_columns():
	return [
		{"fieldname": "movement", "label": _("Movement"), "fieldtype": "Data", "width": 110},
		{
			"fieldname": "booking",
			"label": _("Booking"),
			"fieldtype": "Link",
			"options": "Room Booking",
			"width": 160,
		},
		{"fieldname": "status", "label": _("Status"), "fieldtype": "Data", "width": 110},
		{
			"fieldname": "customer",
			"label": _("Customer"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 180,
		},
		{
			"fieldname": "room",
			"label": _("Room"),
			"fieldtype": "Link",
			"options": "Hotel Room",
			"width": 140,
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
		{"fieldname": "check_in", "label": _("Check In"), "fieldtype": "Datetime", "width": 165},
		{"fieldname": "check_out", "label": _("Check Out"), "fieldtype": "Datetime", "width": 165},
		{"fieldname": "nights", "label": _("Nights"), "fieldtype": "Int", "width": 80},
		{"fieldname": "hours", "label": _("Hours"), "fieldtype": "Float", "width": 90},
		{
			"fieldname": "total_amount",
			"label": _("Total Amount"),
			"fieldtype": "Currency",
			"width": 130,
		},
		{"fieldname": "pay_status", "label": _("Payment"), "fieldtype": "Data", "width": 100},
	]
