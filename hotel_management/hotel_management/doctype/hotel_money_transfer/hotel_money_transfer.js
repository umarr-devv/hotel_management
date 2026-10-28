// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Форма передачи денег. Касса отправителя — только кассы профиля отеля, касса получателя
// по умолчанию — «Касса передачи» профиля (если в профиле её нет, сотрудник выбирает сам).

frappe.ui.form.on("Hotel Money Transfer", {
	setup(frm) {
		frm.set_query("from_account", () => ({
			query: transfer_method("from_account_query"),
			filters: { hotel_profile: frm.doc.hotel_profile || "" },
		}));
		frm.set_query("to_account", () => ({
			query: transfer_method("to_account_query"),
			filters: { from_account: frm.doc.from_account || "" },
		}));
	},

	async onload(frm) {
		if (!frm.is_new()) return;
		if (frm.doc.hotel_profile) {
			// профиль подставил Frappe (разрешения пользователя) — кассы заполняем сами
			if (!frm.doc.from_account && !frm.doc.to_account) set_profile_accounts(frm);
			return;
		}
		// единственный доступный пользователю профиль подставляем сразу
		const profiles = await frappe.db.get_list("Hotel Profile", { limit: 2 });
		if (profiles.length === 1) frm.set_value("hotel_profile", profiles[0].name);
	},

	hotel_profile(frm) {
		set_profile_accounts(frm);
	},
});

async function set_profile_accounts(frm) {
	if (!frm.doc.hotel_profile) return;
	const { message } = await frappe.call({
		method: transfer_method("get_profile_accounts"),
		args: { hotel_profile: frm.doc.hotel_profile },
	});
	const { from_accounts, transfer_account } = message;
	// касса отправителя — если она в профиле одна; чужую кассу сбрасываем
	if (from_accounts.length === 1) {
		frm.set_value("from_account", from_accounts[0]);
	} else if (!from_accounts.includes(frm.doc.from_account)) {
		frm.set_value("from_account", "");
	}
	frm.set_value("to_account", transfer_account || "");
}

function transfer_method(name) {
	return `hotel_management.hotel_management.doctype.hotel_money_transfer.hotel_money_transfer.${name}`;
}
