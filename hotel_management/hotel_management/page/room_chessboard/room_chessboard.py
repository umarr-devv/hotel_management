# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

import re

import frappe
from frappe.utils import cint, get_datetime

from hotel_management.utils import active_room_filters


def _natural_key(value):
	return [cint(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", value or "")]


@frappe.whitelist()
def get_rooms(hotel_building=None, room_type=None):
	"""Номера для строк шахматки, отсортированные: здание → этаж → номер.

	Отключённые номера и номера отключённых типов не показываются.
	"""
	filters = active_room_filters()
	if hotel_building:
		filters.append(["hotel_building", "=", hotel_building])
	if room_type:
		filters.append(["room_type", "=", room_type])

	rooms = frappe.get_list(
		"Hotel Room",
		filters=filters,
		fields=["name", "room_number", "room_type", "hotel_building", "hotel_floor", "floor_number"],
		limit_page_length=0,
	)
	# подпись этажа берём из справочника Hotel Floor (там floor_number — текст, напр. «1 Этаж»)
	floors = dict(frappe.get_all("Hotel Floor", fields=["name", "floor_number"], as_list=True))
	for r in rooms:
		r.floor_label = floors.get(r.hotel_floor) or (str(r.floor_number) if r.floor_number else None)

	rooms.sort(
		key=lambda r: (
			_natural_key(r.hotel_building),
			_natural_key(r.floor_label),
			_natural_key(r.hotel_floor),
			_natural_key(re.sub(r"^\D+", "", r.room_number or r.name)),
		)
	)
	return rooms


@frappe.whitelist()
def get_bookings(start, end, hotel_building=None, room_type=None, status=None):
	"""Брони (кроме отменённых), пересекающие период [start, end)."""
	start, end = get_datetime(start), get_datetime(end)
	if end <= start:
		return []

	filters = [
		["docstatus", "<", 2],
		["check_in", "<", end],
		["check_out", ">", start],
	]
	if status:
		filters.append(["status", "=", status])
	# только брони номеров, которые есть на шахматке (без отключённых)
	rooms = [r.name for r in get_rooms(hotel_building, room_type)]
	if not rooms:
		return []
	filters.append(["room", "in", rooms])

	bookings = frappe.get_list(
		"Room Booking",
		filters=filters,
		fields=[
			"name",
			"room",
			"customer",
			"company",
			"room_rate",
			"check_in",
			"check_out",
			"total_hours",
			"total_amount",
			"status",
			"pay_status",
			"docstatus",
		],
		order_by="check_in asc",
		limit_page_length=0,
	)
	if not bookings:
		return []

	customers = {b.customer for b in bookings if b.customer}
	customer_info = {
		c.name: c
		for c in frappe.get_all(
			"Customer",
			filters={"name": ["in", list(customers)]},
			fields=["name", "customer_name", "customer_type"],
		)
	}

	guest_count = {}
	for row in frappe.get_all(
		"Room Booking Guest",
		filters={"parenttype": "Room Booking", "parent": ["in", [b.name for b in bookings]]},
		fields=["parent"],
	):
		guest_count[row.parent] = guest_count.get(row.parent, 0) + 1

	for b in bookings:
		info = customer_info.get(b.customer) or {}
		b.customer_name = info.get("customer_name") or b.customer
		b.customer_type = info.get("customer_type") or "Individual"
		b.guests = guest_count.get(b.name, 0)
		b.currency = frappe.get_cached_value("Company", b.company, "default_currency")

	return bookings
