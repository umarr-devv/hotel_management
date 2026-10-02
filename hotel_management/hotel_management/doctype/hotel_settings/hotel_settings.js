// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt

frappe.ui.form.on("Hotel Settings", {
	setup(frm) {
		// отключённые способы оплаты в выборе не показываем
		frm.set_query("mode_of_payment", "modes_of_payment", () => ({ filters: { enabled: 1 } }));
	},
});
