// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Логика формы брони. Раньше это был Client Script «Room Booking Calculation».
// Расчёты дублируют серверный контроллер, чтобы суммы обновлялись сразу при вводе.

frappe.ui.form.on("Room Booking", {
	setup(frm) {
		// отключённые номера и номера отключённых типов в выборе не показываются
		frm.set_query("room", () => ({ query: "hotel_management.api.active_room_query" }));
	},

	async refresh(frm) {
		await load_rates(frm);
		set_room_rate_query(frm);
		lock_paid_fields(frm);
		add_sales_invoice_button(frm);
		// новая бронь из быстрой формы приходит с тарифом, но без цены и сумм
		if (frm.is_new() && frm.doc.room_rate && !frm.doc.rate_by_hour) apply_rate(frm);
	},

	async room(frm) {
		frm.set_value("room_rate", "");
		frm.set_value("rate_by_hour", 0);
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

	items_and_service_remove(frm) {
		calculate_items_amount(frm);
	},
});

// процентные услуги: цена — процент от часового тарифа номера
frappe.ui.form.on("Room Booking Percentage Service", {
	percent: calculate_percentage_services,
	qty: calculate_percentage_services,
	percentage_services_remove: calculate_percentage_services,
});

// --- тарифы ----------------------------------------------------------------

// активные тарифы типа выбранного номера: { название тарифа: цена за час }
async function load_rates(frm) {
	frm.room_rates = {};
	if (!frm.doc.room) return;

	const rows = await frappe.xcall("hotel_management.api.get_room_rates", { room: frm.doc.room });
	(rows || []).forEach((row) => (frm.room_rates[row.room_rate] = flt(row.rate_by_hour)));
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
		frm.set_value("rate_by_hour", 0);
		return;
	}

	frm.set_value("rate_by_hour", rate);
	calculate_percentage_services(frm);
	calculate_totals(frm);
}

// --- расчёты ---------------------------------------------------------------

function calculate_totals(frm) {
	if (!frm.doc.check_in || !frm.doc.check_out) return;

	const hours = moment(frm.doc.check_out).diff(moment(frm.doc.check_in), "hours", true);

	if (hours <= 0) {
		frappe.msgprint(__("Check Out must be after Check In"));
		frm.set_value("total_hours", 0);
		frm.set_value("amount", 0);
	} else {
		frm.set_value("total_hours", hours);
		frm.set_value("amount", flt(frm.doc.rate_by_hour * hours, precision("amount")));
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
		row.rate = flt((flt(frm.doc.rate_by_hour) * flt(row.percent)) / 100, precision("rate", row));
		row.amount = flt(row.rate * flt(row.qty), precision("amount", row));
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
}

// --- счёт ------------------------------------------------------------------

function invoice_has_payments(frm) {
	return !!(frm.doc.__onload && frm.doc.__onload.invoice_has_payments);
}

// после оплаты счёта номер, тариф, даты и услуги менять нельзя (проверяет и сервер)
function lock_paid_fields(frm) {
	const locked = invoice_has_payments(frm) ? 1 : 0;
	["room", "room_rate", "check_in", "check_out", "items_and_service", "percentage_services"].forEach(
		(field) => frm.set_df_property(field, "read_only", locked)
	);
}

function add_sales_invoice_button(frm) {
	// счёт с оплатами пересоздать нельзя
	if (frm.is_new() || frm.doc.pay_status === "Paid" || invoice_has_payments(frm)) return;

	const label = frm.doc.sales_invoice
		? __("Recreate Sales Invoice")
		: __("Create Sales Invoice");

	frm.add_custom_button(label, () => {
		const proceed = () =>
			frappe.call({
				method: "hotel_management.api.make_sales_invoice_from_booking",
				args: { room_booking: frm.doc.name },
				freeze: true,
				freeze_message: __("Creating Sales Invoice..."),
				callback: (r) => {
					if (!r.message) return;
					frm.reload_doc();
					frappe.set_route("Form", "Sales Invoice", r.message);
				},
			});

		if (frm.doc.sales_invoice) {
			frappe.confirm(
				__("Sales Invoice {0} will be cancelled and a new one created. Continue?", [
					frm.doc.sales_invoice,
				]),
				proceed
			);
		} else {
			proceed();
		}
	});
}
