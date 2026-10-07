// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Форма расхода отеля. Суммы дублируют серверный контроллер, чтобы обновлялись сразу при вводе.

frappe.ui.form.on("Hotel Expense", {
	setup(frm) {
		// только способы оплаты профиля отеля
		frm.set_query("mode_of_payment", () => ({
			query: "hotel_management.hotel_management.doctype.hotel_profile.hotel_profile.payment_mode_query",
			filters: { hotel_profile: frm.doc.hotel_profile || "" },
		}));
		frm.set_query("item", "items", () => ({ filters: { disabled: 0, is_purchase_item: 1 } }));
	},

	async onload(frm) {
		if (frm.is_new() && !frm.doc.hotel_profile) {
			// по умолчанию — первый профиль, разрешённый пользователю
			const profiles = await frappe.db.get_list("Hotel Profile", { order_by: "creation asc", limit: 1 });
			if (profiles.length) frm.set_value("hotel_profile", profiles[0].name);
		}
	},
});

frappe.ui.form.on("Hotel Expense Item", {
	qty: update_item_amount,
	rate: update_item_amount,

	items_remove(frm) {
		calculate_total(frm);
	},
});

function update_item_amount(frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	frappe.model.set_value(cdt, cdn, "amount", flt(flt(row.qty) * flt(row.rate), precision("amount", row)));
	calculate_total(frm);
}

function calculate_total(frm) {
	const total = (frm.doc.items || []).reduce((sum, row) => sum + flt(row.amount), 0);
	frm.set_value("total_amount", flt(total, precision("total_amount")));
}
