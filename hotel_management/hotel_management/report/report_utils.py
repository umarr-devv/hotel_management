# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Общие помощники отчётов модуля Hotel Management.

Правила, единые для всех отчётов:
  * учитываются только проведённые брони (docstatus = 1), кроме отменённых;
  * суммы берутся из самой брони (amount / items_and_serivce_amount), а не из
    Sales Invoice: счёт может быть ещё не выставлен;
  * если бронь выходит за границы периода, её выручка делится пропорционально
    часам, попавшим в период.
"""

import frappe
from frappe import _
from frappe.utils import add_days, date_diff, flt, get_datetime, getdate, nowdate

from hotel_management.utils import active_room_filters

# ограничение на длину периода: отчёты считают номеро-сутки в цикле по дням
MAX_PERIOD_DAYS = 366

BOOKING_FIELDS = """
	b.name, b.customer, b.room, b.room_rate, b.status, b.pay_status, b.check_in, b.check_out,
	b.total_hours, b.rate_by_hour, b.amount, b.items_and_serivce_amount, b.total_amount,
	b.sales_invoice, b.company, b.hotel_profile,
	r.room_type, r.hotel_building, r.hotel_floor
"""

# фильтры, которые отбирают бронь по её собственным полям
BOOKING_FILTER_FIELDS = ("company", "customer", "room", "room_rate", "hotel_profile", "status")
# фильтры, которые отбирают бронь по номеру
ROOM_FILTER_FIELDS = ("hotel_building", "hotel_floor", "room_type")


def get_period(filters, default_days=30):
	"""Период отчёта с проверкой границ."""
	to_date = getdate(filters.get("to_date") or nowdate())
	from_date = getdate(filters.get("from_date") or add_days(to_date, -default_days))

	if from_date > to_date:
		frappe.throw(_("From Date must be before To Date"))

	days = date_diff(to_date, from_date) + 1
	if days > MAX_PERIOD_DAYS:
		frappe.throw(_("Period is limited to {0} days").format(MAX_PERIOD_DAYS))

	return from_date, to_date


def period_bounds(from_date, to_date):
	"""Границы периода как datetime: [from_date 00:00, to_date + 1 день 00:00)."""
	start = get_datetime(f"{getdate(from_date)} 00:00:00")
	end = get_datetime(f"{add_days(getdate(to_date), 1)} 00:00:00")
	return start, end


def day_bounds(date):
	return period_bounds(date, date)


def daterange(from_date, to_date):
	day = getdate(from_date)
	last = getdate(to_date)
	while day <= last:
		yield day
		day = add_days(day, 1)


def get_bookings(filters, from_date=None, to_date=None, include_cancelled=False):
	"""Брони, пересекающиеся с периодом, вместе с данными номера."""
	frappe.has_permission("Room Booking", "report", throw=True)

	filters = frappe._dict(filters or {})
	conditions = ["b.docstatus = 1"]
	values = {}

	if not include_cancelled:
		conditions.append("b.status != 'Cancelled'")

	if from_date and to_date:
		start, end = period_bounds(from_date, to_date)
		conditions.append("b.check_in < %(period_end)s and b.check_out > %(period_start)s")
		values.update(period_start=start, period_end=end)

	for field in BOOKING_FILTER_FIELDS:
		if filters.get(field):
			conditions.append(f"b.{field} = %({field})s")
			values[field] = filters.get(field)

	for field in ROOM_FILTER_FIELDS:
		if filters.get(field):
			conditions.append(f"r.{field} = %({field})s")
			values[field] = filters.get(field)

	return frappe.db.sql(
		f"""
		select {BOOKING_FIELDS}
		from `tabRoom Booking` b
		left join `tabHotel Room` r on r.name = b.room
		where {" and ".join(conditions)}
		order by b.check_in asc, b.name asc
		""",
		values,
		as_dict=True,
	)


def get_rooms(filters):
	"""Номера, попадающие под фильтры отчёта (знаменатель загрузки)."""
	frappe.has_permission("Hotel Room", "report", throw=True)

	filters = frappe._dict(filters or {})
	# отключённые номера и номера отключённых типов в номерной фонд не входят
	room_filters = active_room_filters()
	for field in ROOM_FILTER_FIELDS:
		if filters.get(field):
			room_filters.append([field, "=", filters.get(field)])
	if filters.get("room"):
		room_filters.append(["name", "=", filters.get("room")])

	return frappe.get_all(
		"Hotel Room",
		filters=room_filters,
		fields=["name", "room_number", "room_type", "hotel_building", "hotel_floor", "floor_number"],
		order_by="hotel_building asc, floor_number asc, room_number asc",
	)


def overlap_hours(check_in, check_out, start, end):
	"""Сколько часов брони попало в интервал [start, end)."""
	begin = max(get_datetime(check_in), get_datetime(start))
	finish = min(get_datetime(check_out), get_datetime(end))
	if finish <= begin:
		return 0.0
	return (finish - begin).total_seconds() / 3600.0


def booking_hours(booking):
	"""Полная длительность брони в часах."""
	hours = flt(booking.get("total_hours"))
	if hours > 0:
		return hours
	return overlap_hours(booking.check_in, booking.check_out, booking.check_in, booking.check_out)


def revenue_share(booking, hours):
	"""Выручка брони за `hours` часов: (проживание, услуги)."""
	total = booking_hours(booking)
	share = (hours / total) if total else 0.0
	return flt(booking.get("amount")) * share, flt(booking.get("items_and_serivce_amount")) * share


def stay_nights(check_in, check_out):
	"""Ночей в брони; почасовая бронь внутри одних суток считается как 0 ночей."""
	return max(date_diff(getdate(check_out), getdate(check_in)), 0)


def percent(part, whole):
	return flt(part) / flt(whole) * 100 if flt(whole) else 0.0


# --- группировка по дням (загрузка, ADR/RevPAR) ------------------------------

# как получить ключ группировки из номера; None — ключ берётся из даты
GROUP_ROOM_FIELD = {
	"Date": None,
	"Month": None,
	"Room Type": "room_type",
	"Hotel Building": "hotel_building",
	"Hotel Floor": "hotel_floor",
	"Room": "name",
}


def group_key(group_by, day, room):
	if group_by == "Date":
		return str(getdate(day))
	if group_by == "Month":
		return getdate(day).strftime("%Y-%m")

	field = GROUP_ROOM_FIELD.get(group_by)
	if not field:
		frappe.throw(_("Unsupported Group By: {0}").format(group_by))
	return room.get(field) or _("Not Set")


def group_column(group_by, width=160):
	"""Колонка-заголовок группы для отчётов с Group By."""
	column = {"fieldname": "group_value", "label": _(group_by), "fieldtype": "Data", "width": width}
	if group_by == "Date":
		column["fieldtype"] = "Date"
	elif group_by == "Month":
		column["label"] = _("Month")
	elif group_by in ("Room Type", "Hotel Building", "Hotel Floor"):
		column.update(fieldtype="Link", options=group_by)
	elif group_by == "Room":
		column.update(fieldtype="Link", options="Hotel Room")
	return column


def new_group():
	return frappe._dict(
		available_room_days=0,
		occupied_room_days=set(),
		occupied_hours=0.0,
		room_revenue=0.0,
		service_revenue=0.0,
		bookings=set(),
	)


def build_daily_stats(filters, from_date, to_date, group_by):
	"""Посуточная статистика по группам: номеро-сутки, часы и выручка.

	Возвращает (stats, rooms, bookings). Выручка брони делится между днями
	пропорционально часам, попавшим в каждый день.
	"""
	rooms = get_rooms(filters)
	rooms_by_name = {room.name: room for room in rooms}
	bookings = get_bookings(filters, from_date, to_date)

	stats = {}

	def bucket(key):
		return stats.setdefault(key, new_group())

	# знаменатель: сколько номеро-суток вообще было доступно
	for day in daterange(from_date, to_date):
		for room in rooms:
			bucket(group_key(group_by, day, room)).available_room_days += 1

	# числитель: занятые номеро-сутки, часы и выручка
	for booking in bookings:
		room = rooms_by_name.get(booking.room)
		if not room:
			# номер не проходит по фильтрам (или удалён) — в загрузке не участвует
			continue
		for day in daterange(from_date, to_date):
			start, end = day_bounds(day)
			hours = overlap_hours(booking.check_in, booking.check_out, start, end)
			if not hours:
				continue
			group = bucket(group_key(group_by, day, room))
			group.occupied_room_days.add((booking.room, day))
			group.occupied_hours += hours
			group.bookings.add(booking.name)
			room_revenue, service_revenue = revenue_share(booking, hours)
			group.room_revenue += room_revenue
			group.service_revenue += service_revenue

	return stats, rooms, bookings


def sort_group_keys(stats, group_by):
	keys = list(stats.keys())
	if group_by in ("Date", "Month"):
		return sorted(keys)
	return sorted(keys, key=lambda key: -stats[key].room_revenue)
