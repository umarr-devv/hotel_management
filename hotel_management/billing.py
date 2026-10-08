# Copyright (c) 2026, umarr and contributors
# For license information, please see license.txt

"""Счета брони: плательщики, их доли и Sales Invoice.

Плательщики брони — таблица payers (Room Booking Payer):
  * проживание и процентные услуги делятся между плательщиками по долям (share,
    сумма долей — 100%), копейки от округления достаются последнему плательщику с долей;
  * доп. товар или услугу оплачивает плательщик строки (payer), а если он не указан —
    заказчик брони, если он среди плательщиков, иначе первый плательщик.

У каждого плательщика свой Sales Invoice. Исключение — организатор групповой брони:
всё, что он оплачивает во всех бронях группы, собирается в один общий счёт группы.

Сумма плательщика, по счёту которого уже есть оплата, меняться не может — иначе счёт
разойдётся с бронью, а пересоздать оплаченный счёт нельзя.
"""

import frappe
from frappe import _
from frappe.utils import flt, format_datetime

# состояние счёта плательщика
NOTHING_TO_PAY = "Nothing to Pay"
NOT_INVOICED = "Not Invoiced"
OUTDATED = "Outdated"
UNPAID = "Unpaid"
PARTIALLY_PAID = "Partially Paid"
PAID = "Paid"

# такие счета нужно выставить или пересоздать
NEEDS_INVOICE = (NOT_INVOICED, OUTDATED)


def get_rate_with_markup(row):
	"""Цена доп. товара/услуги с наценкой — по ней строка входит в сумму брони и в счёт.

	Округляется до точности цены, чтобы сумма строки совпала с суммой строки счёта.
	"""
	return flt(flt(row.rate) * (1 + flt(row.markup) / 100), row.precision("rate"))


def get_currency_precision():
	return frappe.get_precision("Sales Invoice", "grand_total") or 2


# --- доли плательщиков ----------------------------------------------------------


def get_default_services_payer(booking):
	"""Кто оплачивает доп. товары и услуги без указанного плательщика."""
	payers = [row.payer for row in booking.payers if row.payer]
	if booking.customer in payers:
		return booking.customer
	return payers[0] if payers else None


def split_amount(amount, rows, precision):
	"""Разделить сумму по долям строк плательщиков: {payer: сумма}.

	Остаток от округления получает последняя строка с ненулевой долей, поэтому
	части всегда в точности складываются в сумму.
	"""
	with_share = [row for row in rows if row.payer and flt(row.share) > 0]
	parts = {}
	rest = flt(amount, precision)
	for row in with_share[:-1]:
		part = flt(flt(amount) * flt(row.share) / 100, precision)
		parts[row.payer] = part
		rest = flt(rest - part, precision)
	if with_share:
		parts[with_share[-1].payer] = rest
	return parts


def get_payer_lines(booking):
	"""Строки счёта каждого плательщика брони: {payer: [line, ...]}.

	line — frappe._dict(item_code, qty, rate, amount, description). У проживания
	item_code пустой: счёт подставит услугу по умолчанию из профиля отеля.
	"""
	precision = booking.precision("amount")
	shares = {row.payer: flt(row.share) for row in booking.payers if row.payer}
	lines = {payer: [] for payer in shares}

	def add(payer, **line):
		if payer in lines and flt(line["amount"]):
			lines[payer].append(frappe._dict(line))

	stay = _("Room {0}: {1} – {2}").format(
		booking.room,
		format_datetime(booking.check_in, "dd.MM.yyyy HH:mm"),
		format_datetime(booking.check_out, "dd.MM.yyyy HH:mm"),
	)
	for payer, amount in split_amount(booking.amount, booking.payers, precision).items():
		description = stay if shares[payer] >= 100 else f"{stay} ({flt(shares[payer])}%)"
		add(payer, item_code=None, qty=1, rate=amount, amount=amount, description=description)

	for row in booking.percentage_services:
		for payer, amount in split_amount(row.amount, booking.payers, precision).items():
			add(payer, item_code=row.item, qty=1, rate=amount, amount=amount, description=None)

	default_payer = get_default_services_payer(booking)
	for row in booking.items_and_service:
		add(
			row.payer or default_payer,
			item_code=row.item,
			qty=flt(row.qty),
			rate=get_rate_with_markup(row),
			amount=flt(row.amount),
			description=None,
		)
	return lines


def set_payer_amounts(booking):
	"""Сумма каждого плательщика — сумма его строк счёта."""
	lines = get_payer_lines(booking)
	for row in booking.payers:
		row.amount = flt(sum(flt(line.amount) for line in lines.get(row.payer, [])), row.precision("amount"))


# --- состояние счетов -----------------------------------------------------------


def get_invoice_states(names):
	"""Сведения о счетах: {name: frappe._dict(docstatus, grand_total, outstanding_amount, ...)}."""
	names = list({name for name in names if name})
	if not names:
		return {}

	precision = frappe.get_precision("Sales Invoice", "outstanding_amount")
	states = {}
	for si in frappe.get_all(
		"Sales Invoice",
		filters={"name": ["in", names]},
		fields=[
			"name",
			"docstatus",
			"customer",
			"currency",
			"grand_total",
			"rounded_total",
			"outstanding_amount",
		],
	):
		# при включённом округлении остаток считается от округлённой суммы
		total = flt(si.rounded_total) or flt(si.grand_total)
		si.outstanding_amount = flt(si.outstanding_amount, precision)
		si.submitted = si.docstatus == 1
		si.paid_amount = flt(total - si.outstanding_amount, precision) if si.submitted else 0.0
		si.has_payments = si.submitted and si.outstanding_amount < flt(total, precision)
		states[si.name] = si
	return states


def get_invoice_totals(names, booking=None):
	"""Сколько должно быть в каждом счёте: сумма строк плательщиков всех броней со ссылкой на него.

	booking — сохраняемая бронь: её строки берутся из документа, а не из базы.
	"""
	names = list({name for name in names if name})
	if not names:
		return {}

	exclude = booking.name if booking and booking.name else ""
	totals = dict(
		frappe.db.sql(
			"""
			select p.sales_invoice, sum(p.amount)
			from `tabRoom Booking Payer` p
			inner join `tabRoom Booking` b on b.name = p.parent
			where p.parenttype = 'Room Booking' and b.docstatus < 2
				and p.sales_invoice in %(names)s and b.name != %(exclude)s
			group by p.sales_invoice
			""",
			{"names": names, "exclude": exclude},
		)
	)
	totals = {name: flt(total) for name, total in totals.items()}
	if booking:
		for row in booking.payers:
			if row.sales_invoice in names:
				totals[row.sales_invoice] = totals.get(row.sales_invoice, 0.0) + flt(row.amount)
	return totals


def get_billing(booking):
	"""Счета плательщиков брони — для формы, шахматки, отчётов и статуса оплаты.

	Для общего счёта группы оплата делится между бронями пропорционально их суммам.
	"""
	invoices = [row.sales_invoice for row in booking.payers]
	return get_rows_billing(
		booking.payers, get_invoice_states(invoices), get_invoice_totals(invoices, booking)
	)


def get_rows_billing(rows, states, totals):
	"""Состояние счетов строк плательщиков по уже собранным сведениям о счетах."""
	precision = get_currency_precision()
	billing = []
	for row in rows:
		state = states.get(row.sales_invoice)
		submitted = bool(state and state.submitted)
		amount = flt(row.amount, precision)
		expected = flt(totals.get(row.sales_invoice, amount), precision)
		outdated = submitted and flt(state.grand_total, precision) != expected
		# часть оплаты счёта, которая приходится на эту бронь
		ratio = (amount / expected) if submitted and expected else 0.0
		paid = flt(state.paid_amount * ratio, precision) if submitted else 0.0

		if not submitted:
			status = NOTHING_TO_PAY if amount <= 0 else NOT_INVOICED
		elif outdated:
			status = OUTDATED
		elif state.outstanding_amount <= 0:
			status = PAID
		elif state.has_payments:
			status = PARTIALLY_PAID
		else:
			status = UNPAID

		billing.append(
			frappe._dict(
				row_name=row.name,
				payer=row.payer,
				share=flt(row.share),
				amount=amount,
				sales_invoice=row.sales_invoice if submitted else None,
				shared=submitted and expected != amount,
				invoice_total=flt(state.grand_total) if submitted else 0.0,
				# часть счёта, которая приходится на эту бронь (у общего счёта группы — доля)
				invoiced_amount=flt(flt(state.grand_total) * ratio, precision) if submitted else 0.0,
				outstanding_amount=state.outstanding_amount if submitted else 0.0,
				currency=state.currency if state else None,
				has_payments=bool(state and state.has_payments),
				paid_amount=paid,
				balance_due=max(flt(amount - paid, precision), 0.0),
				status=status,
				payable=submitted and not outdated and state.outstanding_amount > 0,
			)
		)
	return billing


def add_payer_names(billing):
	"""Добавить к счетам плательщиков их имена (customer_name) — для показа."""
	payers = [row.payer for row in billing if row.payer]
	names = (
		dict(
			frappe.get_all(
				"Customer", filters={"name": ["in", payers]}, fields=["name", "customer_name"], as_list=True
			)
		)
		if payers
		else {}
	)
	for row in billing:
		row.payer_name = names.get(row.payer) or row.payer
	return billing


def get_pay_status(billing):
	"""Статус оплаты брони по счетам её плательщиков."""
	due = [row for row in billing if row.amount > 0]
	if due and all(row.status == PAID for row in due):
		return PAID
	if any(row.has_payments for row in billing):
		return PARTIALLY_PAID
	return UNPAID


def update_pay_status(booking_names):
	"""Пересчитать статус оплаты броней (после выставления счетов и оплат)."""
	for name in {name for name in booking_names if name}:
		booking = frappe.get_doc("Room Booking", name)
		status = get_pay_status(get_billing(booking))
		if booking.pay_status != status:
			booking.db_set("pay_status", status, update_modified=False)


def get_invoice_bookings(sales_invoice):
	"""Брони, в строках плательщиков которых есть ссылка на счёт (у общего счёта группы — несколько)."""
	return frappe.get_all(
		"Room Booking Payer",
		filters={"parenttype": "Room Booking", "sales_invoice": sales_invoice},
		pluck="parent",
		distinct=True,
	)


# --- выставление счетов -----------------------------------------------------------


def make_booking_invoices(booking):
	"""Выставить недостающие и пересоздать устаревшие счета плательщиков брони.

	Возвращает имена выставленных счетов.
	"""
	if not booking.hotel_profile:
		frappe.throw(_("Set Hotel Profile on the booking"))

	organizer = get_group_organizer(booking)
	created = []
	affected = {booking.name}
	rows = {row.name: row for row in booking.payers}
	for state in get_billing(booking):
		if state.status not in NEEDS_INVOICE:
			continue
		if organizer and state.payer == organizer:
			# всё, что платит организатор группы, — в одном общем счёте группы
			invoice, bookings = sync_group_invoice(booking.group_booking)
			affected.update(bookings)
			if invoice:
				created.append(invoice)
			continue
		invoice = sync_payer_invoice(booking, rows[state.row_name], state)
		if invoice:
			created.append(invoice)

	update_pay_status(affected)
	return list(dict.fromkeys(created))


def sync_payer_invoice(booking, row, state):
	"""Пересоздать счёт одного плательщика брони; без суммы — только отменить старый."""
	if state.has_payments:
		frappe.throw(
			_("Sales Invoice {0} already has payments and cannot be recreated").format(
				frappe.bold(row.sales_invoice)
			)
		)

	old = row.sales_invoice
	new = None
	if flt(row.amount) > 0:
		lines = get_payer_lines(booking).get(row.payer) or []
		new = make_sales_invoice(row.payer, booking.company, booking.hotel_profile, lines)

	frappe.db.set_value("Room Booking Payer", row.name, "sales_invoice", new)
	row.sales_invoice = new
	if old and old != new:
		cancel_sales_invoice(old, ignore_permissions=True)
	return new


def sync_group_invoice(group_booking):
	"""Общий счёт организатора группы: все его строки во всех бронях группы.

	Возвращает (счёт, брони группы со строкой организатора).
	"""
	group = frappe.get_doc("Group Booking", group_booking)
	rows = frappe.db.sql(
		"""
		select p.name, p.parent, p.amount, p.sales_invoice
		from `tabRoom Booking Payer` p
		inner join `tabRoom Booking` b on b.name = p.parent
		where p.parenttype = 'Room Booking' and b.docstatus < 2
			and b.group_booking = %(group)s and p.payer = %(organizer)s
		order by b.creation asc, p.idx asc
		""",
		{"group": group.name, "organizer": group.organizer},
		as_dict=True,
	)
	bookings = [row.parent for row in rows]
	precision = get_currency_precision()
	expected = flt(sum(flt(row.amount) for row in rows), precision)

	current = group.sales_invoice
	states = get_invoice_states([current, *(row.sales_invoice for row in rows)])
	state = states.get(current)
	linked = all(row.sales_invoice == (current if flt(row.amount) > 0 else None) for row in rows)
	if state and state.submitted and flt(state.grand_total, precision) == expected and linked:
		return current, bookings

	# старые счета организатора в бронях группы (обычно это и есть общий счёт)
	old_invoices = {current, *(row.sales_invoice for row in rows)} - {None, ""}
	for name in old_invoices:
		if states.get(name) and states[name].has_payments:
			frappe.throw(
				_("Sales Invoice {0} already has payments and cannot be recreated").format(frappe.bold(name))
			)

	lines = []
	for name in dict.fromkeys(row.parent for row in rows if flt(row.amount) > 0):
		booking = frappe.get_doc("Room Booking", name)
		lines.extend(get_payer_lines(booking).get(group.organizer) or [])

	new = make_sales_invoice(group.organizer, group.company, group.hotel_profile, lines) if lines else None
	for row in rows:
		frappe.db.set_value(
			"Room Booking Payer", row.name, "sales_invoice", new if flt(row.amount) > 0 else None
		)
	group.db_set("sales_invoice", new)

	for name in old_invoices - {new}:
		cancel_sales_invoice(name, ignore_permissions=True)
	return new, bookings


def make_sales_invoice(customer, company, hotel_profile, lines):
	"""Создать и провести Sales Invoice по строкам счёта плательщика."""
	profile = frappe.get_cached_doc("Hotel Profile", hotel_profile)
	if not profile.default_service:
		frappe.throw(_("Default Service is not set in Hotel Profile"))

	si = frappe.new_doc("Sales Invoice")
	si.customer = customer
	si.company = company
	for line in lines:
		item = {
			"item_code": line.item_code or profile.default_service,
			"qty": flt(line.qty),
			"rate": flt(line.rate),
			"warehouse": profile.warehouse,
		}
		if line.description:
			item["description"] = line.description
		si.append("items", item)

	si.insert(ignore_permissions=True)
	# счёт сразу проводим — по нему можно принимать оплату
	si.submit()
	return si.name


def cancel_sales_invoice(name, ignore_permissions=False):
	"""Отменить проведённый счёт или удалить его черновик."""
	if not (name and frappe.db.exists("Sales Invoice", name)):
		return

	si = frappe.get_doc("Sales Invoice", name)
	si.flags.ignore_permissions = ignore_permissions
	if si.docstatus == 1:
		si.cancel()
	elif si.docstatus == 0:
		si.delete(ignore_permissions=ignore_permissions)


def get_group_organizer(booking):
	"""Организатор групповой брони — его счета собираются в общий счёт группы."""
	if not booking.get("group_booking"):
		return None
	return frappe.db.get_value("Group Booking", booking.group_booking, "organizer")
