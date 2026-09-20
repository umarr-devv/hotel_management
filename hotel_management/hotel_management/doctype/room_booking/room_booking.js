// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Логика формы брони. Раньше это был Client Script «Room Booking Calculation».
// Расчёты дублируют серверный контроллер, чтобы суммы обновлялись сразу при вводе.

frappe.ui.form.on("Room Booking", {
	async refresh(frm) {
		await load_rates(frm);
		set_room_rate_query(frm);
		add_sales_invoice_button(frm);
	},

	async room(frm) {
		frm.set_value("room_rate", "");
		frm.set_value("rate_by_hour", 0);
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

	qty(frm, cdt, cdn) {
		calculate_row_amount(cdt, cdn);
		calculate_items_amount(frm);
	},

	items_and_service_remove(frm) {
		calculate_items_amount(frm);
	},
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
			calculate_row_amount(cdt, cdn);
			calculate_items_amount(frm);
		});
}

function calculate_row_amount(cdt, cdn) {
	const row = locals[cdt][cdn];
	frappe.model.set_value(cdt, cdn, "amount", flt(row.rate) * flt(row.qty || 0));
}

function calculate_items_amount(frm) {
	let total = 0;
	(frm.doc.items_and_service || []).forEach((row) => (total += flt(row.amount)));
	frm.set_value("items_and_serivce_amount", total);
	calculate_total_amount(frm);
}

function calculate_total_amount(frm) {
	frm.set_value("total_amount", flt(frm.doc.amount) + flt(frm.doc.items_and_serivce_amount));
}

// --- счёт ------------------------------------------------------------------

function add_sales_invoice_button(frm) {
	if (frm.is_new() || frm.doc.pay_status === "Paid") return;

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
