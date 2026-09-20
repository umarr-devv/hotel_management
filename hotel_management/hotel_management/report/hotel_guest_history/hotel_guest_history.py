# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""История гостей: сколько раз жил, сколько принёс и что предпочитает.

Бронь относится к периоду по дате заезда, суммы берутся целиком (без деления
по дням) — это отчёт про гостя, а не про загрузку.
"""

from collections import Counter

import frappe
from frappe import _
from frappe.utils import flt, getdate

from hotel_management.hotel_management.report.report_utils import (
	booking_hours,
	get_bookings,
	get_period,
	stay_nights,
)


def execute(filters=None):
	filters = frappe._dict(filters or {})
	from_date, to_date = get_period(filters, default_days=365)
	min_stays = max(int(filters.get("min_stays") or 0), 0)

	guests = {}
	for booking in get_bookings(filters, from_date, to_date, include_cancelled=True):
		if not (from_date <= getdate(booking.check_in) <= to_date):
			# бронь только пересекает период, а заезд был раньше — в историю не берём
			continue
		add_booking(guests.setdefault(booking.customer, new_guest()), booking)

	rows = []
	for customer, guest in guests.items():
		if guest.stays < min_stays:
			continue
		total_revenue = guest.room_revenue + guest.service_revenue
		favourite = guest.room_types.most_common(1)
		rows.append(
			{
				"customer": customer,
				"stays": guest.stays,
				"nights": guest.nights,
				"hours": flt(guest.hours, 1),
				"first_stay": guest.first_stay,
				"last_stay": guest.last_stay,
				"room_revenue": flt(guest.room_revenue, 2),
				"service_revenue": flt(guest.service_revenue, 2),
				"total_revenue": flt(total_revenue, 2),
				"avg_per_stay": flt(total_revenue / guest.stays, 2) if guest.stays else 0,
				"unpaid_amount": flt(guest.unpaid_amount, 2),
				"cancelled": guest.cancelled,
				"favourite_room_type": favourite[0][0] if favourite else None,
			}
		)

	rows.sort(key=lambda row: row["total_revenue"], reverse=True)

	return get_columns(), rows, None, None, get_report_summary(rows)


def new_guest():
	return frappe._dict(
		stays=0,
		nights=0,
		hours=0.0,
		room_revenue=0.0,
		service_revenue=0.0,
		unpaid_amount=0.0,
		cancelled=0,
		first_stay=None,
		last_stay=None,
		room_types=Counter(),
	)


def add_booking(guest, booking):
	if booking.status == "Cancelled":
		guest.cancelled += 1
		return

	guest.stays += 1
	guest.nights += stay_nights(booking.check_in, booking.check_out)
	guest.hours += booking_hours(booking)
	guest.room_revenue += flt(booking.amount)
	guest.service_revenue += flt(booking.items_and_serivce_amount)
	if booking.pay_status != "Paid":
		guest.unpaid_amount += flt(booking.total_amount)
	if booking.room_type:
		guest.room_types[booking.room_type] += 1

	check_in = getdate(booking.check_in)
	check_out = getdate(booking.check_out)
	guest.first_stay = min(guest.first_stay or check_in, check_in)
	guest.last_stay = max(guest.last_stay or check_out, check_out)


def get_report_summary(rows):
	repeat = len([row for row in rows if row["stays"] > 1])
	return [
		{"label": _("Guests"), "value": len(rows), "datatype": "Int"},
		{"label": _("Repeat Guests"), "value": repeat, "datatype": "Int", "indicator": "Green"},
		{"label": _("Stays"), "value": sum(row["stays"] for row in rows), "datatype": "Int"},
		{
			"label": _("Total Revenue"),
			"value": sum(row["total_revenue"] for row in rows),
			"datatype": "Currency",
		},
	]


def get_columns():
	return [
		{
			"fieldname": "customer",
			"label": _("Guest"),
			"fieldtype": "Link",
			"options": "Customer",
			"width": 200,
		},
		{"fieldname": "stays", "label": _("Stays"), "fieldtype": "Int", "width": 90},
		{"fieldname": "nights", "label": _("Nights"), "fieldtype": "Int", "width": 90},
		{"fieldname": "hours", "label": _("Hours"), "fieldtype": "Float", "width": 100},
		{"fieldname": "first_stay", "label": _("First Stay"), "fieldtype": "Date", "width": 110},
		{"fieldname": "last_stay", "label": _("Last Stay"), "fieldtype": "Date", "width": 110},
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
			"fieldname": "avg_per_stay",
			"label": _("Avg per Stay"),
			"fieldtype": "Currency",
			"width": 130,
		},
		{"fieldname": "unpaid_amount", "label": _("Unpaid"), "fieldtype": "Currency", "width": 130},
		{"fieldname": "cancelled", "label": _("Cancelled"), "fieldtype": "Int", "width": 110},
		{
			"fieldname": "favourite_room_type",
			"label": _("Favourite Room Type"),
			"fieldtype": "Link",
			"options": "Room Type",
			"width": 170,
		},
	]
