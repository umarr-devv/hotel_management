// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Логика формы брони. Раньше это был Client Script «Room Booking Calculation».
// Расчёты дублируют серверный контроллер, чтобы суммы обновлялись сразу при вводе.
// Счета плательщиков и оплата — общий модуль hotel_billing.js:
// {% include 'hotel_management/public/js/hotel_billing.js' %}

frappe.ui.form.on("Room Booking", {
	setup(frm) {
		// отключённые номера и номера отключённых типов в выборе не показываются
		frm.set_query("room", () => ({ query: "hotel_management.api.active_room_query" }));
		// плательщик услуги — только из таблицы плательщиков брони
		frm.set_query("payer", "items_and_service", () => ({
			filters: { name: ["in", (frm.doc.payers || []).map((row) => row.payer).filter(Boolean)] },
		}));
		hotel_management.billing.load_css();
	},

	async refresh(frm) {
		await load_rates(frm);
		set_room_rate_query(frm);
		lock_paid_fields(frm);
		render_billing(frm);
		add_billing_buttons(frm);
		add_payer_buttons(frm);
		show_group(frm);
		// новая бронь из быстрой формы приходит с тарифом, но без цены и сумм
		if (frm.is_new() && frm.doc.room_rate && !frm.doc.rate_per_day) apply_rate(frm);
	},

	customer(frm) {
		set_default_payer(frm);
	},

	async room(frm) {
		frm.set_value("room_rate", "");
		frm.set_value("rate_per_day", 0);
		calculate_percentage_services(frm);
		await load_rates(frm);
		set_room_rate_query(frm);
	},

	room_rate(frm) {
		apply_rate(frm);
	},

	check_in(frm) {
		calculate_totals(frm);
	},

	check_out(frm) {
		calculate_totals(frm);
	},
});

frappe.ui.form.on("Room Booking Item", {
	item: fetch_item_rate,
	price_list: fetch_item_rate,
	qty: update_item_amount,
	rate: update_item_amount,
	markup: update_item_amount,

	payer: calculate_payer_amounts,

	items_and_service_remove(frm) {
		calculate_items_amount(frm);
	},
});

// плательщики: проживание и процентные услуги делятся по долям, у каждого свой счёт
frappe.ui.form.on("Room Booking Payer", {
	payer: calculate_payer_amounts,
	share: calculate_payer_amounts,
	payers_remove: calculate_payer_amounts,
});

// процентные услуги: цена — процент от суточного тарифа номера, количество всегда 1
frappe.ui.form.on("Room Booking Percentage Service", {
	percent: calculate_percentage_services,
	percentage_services_remove: calculate_percentage_services,
});

// --- тарифы ----------------------------------------------------------------

// активные тарифы типа выбранного номера: { название тарифа: цена за сутки }
async function load_rates(frm) {
	frm.room_rates = {};
	if (!frm.doc.room) return;

	const rows = await frappe.xcall("hotel_management.api.get_room_rates", { room: frm.doc.room });
	(rows || []).forEach((row) => (frm.room_rates[row.room_rate] = flt(row.rate_per_day)));
}

function set_room_rate_query(frm) {
	frm.set_query("room_rate", () => {
		if (!frm.doc.room) return {};
		return { filters: { name: ["in", Object.keys(frm.room_rates || {})] } };
	});
}

function apply_rate(frm) {
	if (!frm.doc.room || !frm.doc.room_rate) return;

	const rate = (frm.room_rates || {})[frm.doc.room_rate];
	if (rate == null) {
		frappe.msgprint(__("No active rates for this room type"));
		frm.set_value("rate_per_day", 0);
		return;
	}

	frm.set_value("rate_per_day", rate);
	calculate_percentage_services(frm);
	calculate_totals(frm);
}

// --- расчёты ---------------------------------------------------------------

function calculate_totals(frm) {
	if (!frm.doc.check_in || !frm.doc.check_out) return;

	const hours = flt(
		moment(frm.doc.check_out).diff(moment(frm.doc.check_in), "hours", true),
		precision("total_hours")
	);

	if (hours <= 0) {
		frappe.msgprint(__("Check Out must be after Check In"));
		frm.set_value("total_hours", 0);
		frm.set_value("total_days", 0);
		frm.set_value("amount", 0);
	} else {
		// тариф суточный: платятся начатые сутки (25 ч — 2 суток), как на сервере
		const days = Math.ceil(hours / 24);
		frm.set_value("total_hours", hours);
		frm.set_value("total_days", days);
		frm.set_value("amount", flt(frm.doc.rate_per_day * days, precision("amount")));
	}

	calculate_total_amount(frm);
}

function fetch_item_rate(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row.item || !row.price_list) return;

	frappe.db
		.get_value(
			"Item Price",
			{ item_code: row.item, price_list: row.price_list },
			"price_list_rate"
		)
		.then((r) => {
			const rate = (r.message && r.message.price_list_rate) || 0;
			frappe.model.set_value(cdt, cdn, "rate", rate);
			if (!rate) {
				frappe.msgprint(__("No price found for this item in the selected price list"));
			}
			update_item_amount(frm, cdt, cdn);
		});
}

function update_item_amount(frm, cdt, cdn) {
	calculate_row_amount(cdt, cdn);
	calculate_items_amount(frm);
}

// сумма строки = цена с наценкой × количество; цену с наценкой округляем, как сервер
function calculate_row_amount(cdt, cdn) {
	const row = locals[cdt][cdn];
	const rate = flt(flt(row.rate) * (1 + flt(row.markup) / 100), precision("rate", row));
	frappe.model.set_value(cdt, cdn, "amount", flt(rate * flt(row.qty), precision("amount", row)));
}

function calculate_items_amount(frm) {
	let total = 0;
	(frm.doc.items_and_service || []).forEach((row) => (total += flt(row.amount)));
	frm.set_value("items_and_serivce_amount", total);
	calculate_total_amount(frm);
}

function calculate_percentage_services(frm) {
	let total = 0;
	(frm.doc.percentage_services || []).forEach((row) => {
		row.qty = 1;
		row.rate = flt((flt(frm.doc.rate_per_day) * flt(row.percent)) / 100, precision("rate", row));
		row.amount = row.rate;
		total += row.amount;
	});
	frm.refresh_field("percentage_services");
	frm.set_value("percentage_services_amount", total);
	calculate_total_amount(frm);
}

function calculate_total_amount(frm) {
	frm.set_value(
		"total_amount",
		flt(frm.doc.amount) +
			flt(frm.doc.items_and_serivce_amount) +
			flt(frm.doc.percentage_services_amount)
	);
	calculate_payer_amounts(frm);
}

// --- плательщики -------------------------------------------------------------
// Делёж — как в hotel_management/billing.py: копейки от округления получает последний
// плательщик с долей, услуги без плательщика — заказчик брони или первый плательщик.

function split_amount(amount, rows, prec) {
	const with_share = rows.filter((row) => row.payer && flt(row.share) > 0);
	const parts = {};
	let rest = flt(amount, prec);
	with_share.slice(0, -1).forEach((row) => {
		const part = flt((flt(amount) * flt(row.share)) / 100, prec);
		parts[row.payer] = part;
		rest = flt(rest - part, prec);
	});
	if (with_share.length) parts[with_share[with_share.length - 1].payer] = rest;
	return parts;
}

function calculate_payer_amounts(frm) {
	const rows = frm.doc.payers || [];
	if (!rows.length) return;

	const prec = precision("amount");
	const totals = {};
	const add = (payer, amount) => {
		if (payer) totals[payer] = (totals[payer] || 0) + flt(amount);
	};
	const add_split = (amount) =>
		Object.entries(split_amount(amount, rows, prec)).forEach(([payer, part]) => add(payer, part));

	add_split(frm.doc.amount);
	(frm.doc.percentage_services || []).forEach((row) => add_split(row.amount));

	const payers = rows.map((row) => row.payer).filter(Boolean);
	const default_payer = payers.includes(frm.doc.customer) ? frm.doc.customer : payers[0];
	(frm.doc.items_and_service || []).forEach((row) => add(row.payer || default_payer, row.amount));

	rows.forEach((row) => (row.amount = flt(totals[row.payer] || 0, precision("amount", row))));
	frm.refresh_field("payers");
}

// без плательщиков платит заказчик; единственный плательщик без счёта меняется вместе с заказчиком
function set_default_payer(frm) {
	if (!frm.doc.customer) return;
	const rows = frm.doc.payers || [];
	if (!rows.length) {
		frm.add_child("payers", { payer: frm.doc.customer, share: 100 });
	} else if (rows.length === 1 && !rows[0].sales_invoice) {
		rows[0].payer = frm.doc.customer;
	} else {
		return;
	}
	calculate_payer_amounts(frm);
}

function add_payer_buttons(frm) {
	const grid = frm.fields_dict.payers.grid;
	grid.clear_custom_buttons && grid.clear_custom_buttons();
	if (frm.doc.status === "Completed" || frm.doc.docstatus === 2) return;

	// гости брони становятся плательщиками с нулевой долей
	grid.add_custom_button(__("Add Guests"), () => {
		const payers = new Set((frm.doc.payers || []).map((row) => row.payer));
		const guests = (frm.doc.guests || []).map((row) => row.guest).filter((g) => g && !payers.has(g));
		if (!guests.length) {
			frappe.show_alert({ message: __("All guests are already payers"), indicator: "orange" });
			return;
		}
		guests.forEach((guest) => frm.add_child("payers", { payer: guest, share: 0 }));
		calculate_payer_amounts(frm);
	});

	// проживание поровну; остаток доли — последнему, чтобы в сумме было ровно 100%
	grid.add_custom_button(__("Split Equally"), () => {
		const rows = frm.doc.payers || [];
		if (!rows.length) return;
		const share = flt(100 / rows.length, 2);
		rows.forEach((row, i) => {
			row.share = i === rows.length - 1 ? flt(100 - share * (rows.length - 1), 2) : share;
		});
		frm.dirty();
		calculate_payer_amounts(frm);
	});
}

// --- счета -------------------------------------------------------------------

function billing_rows(frm) {
	return (frm.doc.__onload && frm.doc.__onload.billing) || [];
}

function render_billing(frm) {
	const rows = frm.is_new() ? [] : billing_rows(frm);
	frm.fields_dict.billing_summary.$wrapper.html(
		rows.length
			? hotel_management.billing.summary_html(rows)
			: `<div class="text-muted small">${__("Invoices appear here after they are created")}</div>`
	);
}

// плательщик с долей проживания уже платил — номер, тариф и даты менять нельзя (проверяет и сервер)
function lock_paid_fields(frm) {
	const locked = billing_rows(frm).some((row) => row.has_payments && flt(row.share) > 0) ? 1 : 0;
	["room", "room_rate", "check_in", "check_out"].forEach((field) =>
		frm.set_df_property(field, "read_only", locked)
	);
}

function add_billing_buttons(frm) {
	if (frm.is_new() || frm.doc.docstatus === 2) return;
	const rows = billing_rows(frm);

	if (hotel_management.billing.needs_invoices(rows)) {
		frm.add_custom_button(__("Create Invoices"), () => create_invoices(frm, rows));
	}
	if (hotel_management.billing.payable(rows).length) {
		frm.add_custom_button(__("Pay"), () =>
			hotel_management.billing.pay(rows, { room: frm.doc.room, on_done: () => frm.reload_doc() })
		);
	}
}

function create_invoices(frm, rows) {
	if (frm.is_dirty()) {
		frappe.msgprint(__("Save the booking first"));
		return;
	}
	hotel_management.billing.make_invoices(frm.doc.name, rows, () => frm.reload_doc());
}

function show_group(frm) {
	if (!frm.doc.group_booking) return;
	const link = `<a href="${frappe.utils.get_form_link(
		"Group Booking",
		frm.doc.group_booking
	)}">${frappe.utils.escape_html(frm.doc.group_booking)}</a>`;
	frm.dashboard.set_headline(__("Part of group booking {0}", [link]));
}
