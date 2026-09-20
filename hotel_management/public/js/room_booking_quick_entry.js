// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Короткая форма (Quick Entry) для Room Booking.
// Frappe сам подхватывает класс по имени `<DocType без пробелов>QuickEntryForm`,
// поэтому форма открывается везде: из списка, из поля-ссылки, из шахматки.
// Подключается глобально через app_include_js (hooks.py).

frappe.provide("frappe.ui.form");

frappe.ui.form.RoomBookingQuickEntryForm = class RoomBookingQuickEntryForm extends (
	frappe.ui.form.QuickEntryForm
) {
	is_quick_entry() {
		return true;
	}

	get_title() {
		return __("New Booking");
	}

	set_meta_and_mandatory_fields() {
		this.meta = frappe.get_meta(this.doctype);
		this.rates = {}; // room_rate -> rate_by_hour для выбранного номера

		this.docfields = [
			{
				fieldname: "customer",
				label: __("Customer"),
				fieldtype: "Link",
				options: "Customer",
				reqd: 1,
				bold: 1,
			},
			{ fieldtype: "Section Break" },
			{
				fieldname: "room",
				label: __("Room"),
				fieldtype: "Link",
				options: "Hotel Room",
				reqd: 1,
				onchange: () => this.on_room_change(),
			},
			{
				fieldname: "check_in",
				label: __("Check In"),
				fieldtype: "Datetime",
				reqd: 1,
				onchange: () => this.update_summary(),
			},
			{ fieldtype: "Column Break" },
			{
				// Select, а не Link: в Link можно вписать любой существующий тариф вручную,
				// здесь же есть только тарифы типа выбранного номера (как в полной форме)
				fieldname: "room_rate",
				label: __("Room Rate"),
				fieldtype: "Select",
				options: "",
				reqd: 1,
				onchange: () => this.update_summary(),
			},
			{
				fieldname: "check_out",
				label: __("Check Out"),
				fieldtype: "Datetime",
				reqd: 1,
				onchange: () => this.update_summary(),
			},
			{ fieldtype: "Section Break" },
			{ fieldname: "summary", fieldtype: "HTML" },
			{
				fieldtype: "Section Break",
				label: __("More Information"),
				collapsible: 1,
			},
			{
				fieldname: "company",
				label: __("Company"),
				fieldtype: "Link",
				options: "Company",
				reqd: 1,
			},
			{ fieldtype: "Column Break" },
			{
				fieldname: "hotel_profile",
				label: __("Hotel Profile"),
				fieldtype: "Link",
				options: "Hotel Profile",
				reqd: 1,
			},
		];
	}

	render_dialog() {
		super.render_dialog();
		this.$wrapper.addClass("room-booking-quick-entry");
		this.set_missing_defaults();
		this.on_room_change(true);
	}

	async set_missing_defaults() {
		if (!this.get_value("company")) {
			const company =
				frappe.defaults.get_user_default("Company") ||
				frappe.defaults.get_global_default("company");
			company && this.set_value("company", company);
		}
		if (!this.get_value("hotel_profile")) {
			// если профиль отеля один — подставляем его
			const profiles = await frappe.db.get_list("Hotel Profile", { limit: 2 });
			if (profiles.length === 1) this.set_value("hotel_profile", profiles[0].name);
		}
		// если обязательные «служебные» поля заполнены — секцию можно не раскрывать
		const filled = this.get_value("company") && this.get_value("hotel_profile");
		const section = this.fields_dict.company && this.fields_dict.company.section;
		section && section.collapse && section.collapse(!!filled);
	}

	async on_room_change(initial = false) {
		const room = this.get_value("room");
		this.rates = {};

		if (room) {
			const rows = await frappe.xcall("hotel_management.api.get_room_rates", { room });
			// номер могли сменить, пока шёл запрос
			if (room !== this.get_value("room")) return;
			(rows || []).forEach((r) => (this.rates[r.room_rate] = flt(r.rate_by_hour)));
		}

		const current = this.get_value("room_rate");
		const names = Object.keys(this.rates);
		this.set_rate_options(names);
		if (current && names.includes(current)) {
			await this.set_value("room_rate", current);
		} else {
			// единственный тариф подставляем сразу
			await this.set_value("room_rate", names.length === 1 ? names[0] : "");
		}
		if (room && !names.length && !initial) {
			frappe.show_alert({
				message: __("No active rates for this room type"),
				indicator: "orange",
			});
		}
		this.update_summary();
	}

	set_rate_options(names) {
		const field = this.fields_dict.room_rate;
		if (!field) return;
		field.df.options = [""].concat(names).join("\n");
		// поле не блокируем: у заблокированного поля Frappe не показывает отметку обязательности
		field.df.reqd = 1;
		field.df.description = this.get_value("room")
			? names.length
				? ""
				: __("No active rates for this room type")
			: __("Select a room first");
		field.refresh();
	}

	// явная проверка обязательных полей перед сохранением
	insert() {
		const required = [
			["customer", __("Customer")],
			["room", __("Room")],
			["room_rate", __("Room Rate")],
			["check_in", __("Check In")],
			["check_out", __("Check Out")],
			["company", __("Company")],
			["hotel_profile", __("Hotel Profile")],
		];
		const missing = required.filter(([field]) => !this.get_value(field)).map(([, label]) => label);

		if (missing.length) {
			this.working = false; // иначе Frappe заблокирует повторное нажатие «Сохранить»
			missing.forEach((label) => {
				const f = Object.values(this.fields_dict).find((c) => c.df && __(c.df.label) === label);
				f && f.refresh_input && f.refresh_input();
			});
			if (!this.get_value("company") || !this.get_value("hotel_profile")) {
				const section = this.fields_dict.company && this.fields_dict.company.section;
				section && section.collapse && section.collapse(false);
			}
			frappe.msgprint({
				title: __("Missing Fields"),
				message: __("Mandatory fields required: {0}", [missing.map((l) => `<b>${l}</b>`).join(", ")]),
				indicator: "red",
			});
			return new Promise(() => {}); // сохранение не выполняем
		}
		return super.insert();
	}

	update_summary() {
		const field = this.fields_dict.summary;
		if (!field) return;

		const check_in = this.get_value("check_in");
		const check_out = this.get_value("check_out");
		const rate = this.rates[this.get_value("room_rate")];

		if (!check_in || !check_out) {
			field.$wrapper.html("");
			return;
		}

		const hours = moment(check_out).diff(moment(check_in), "hours", true);
		if (hours <= 0) {
			field.$wrapper.html(
				`<div class="text-danger small">${__("Check Out must be after Check In")}</div>`
			);
			return;
		}

		const currency = frappe.defaults.get_default("currency");
		const nights = moment(check_out)
			.startOf("day")
			.diff(moment(check_in).startOf("day"), "days");
		const parts = [
			__("Nights: {0}", [nights]),
			`${flt(hours, 1)} ${__("h")}`,
		];
		if (rate != null) {
			parts.push(
				`${format_currency(rate, currency)} / ${__("h")}`,
				`<b>${format_currency(flt(rate * hours, 2), currency)}</b>`
			);
		}
		field.$wrapper.html(
			`<div class="text-muted" style="padding: 2px 0 6px">${parts.join(" · ")}</div>`
		);
	}
};
