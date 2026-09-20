// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Короткая форма (Quick Entry) для Room Booking.
// Frappe сам подхватывает класс по имени `<DocType без пробелов>QuickEntryForm`,
// поэтому форма открывается везде: из списка, из поля-ссылки, из шахматки.

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
		const me_ref = this; // для onchange в строках таблицы (там this — контрол)
		this.meta = frappe.get_meta(this.doctype);
		this.rates = {}; // room_rate -> rate_by_hour для выбранного номера

		this.docfields = [
			{
				fieldname: "customer",
				label: __("Customer"),
				fieldtype: "Link",
				options: "Customer",
				reqd: 1,
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
				fieldname: "room_rate",
				label: __("Room Rate"),
				fieldtype: "Link",
				options: "Room Rate",
				reqd: 1,
				// только тарифы типа выбранного номера (как в полной форме).
				// Пустой список «in []» Frappe игнорирует, поэтому подставляем заведомо несуществующее имя
				get_query: () => {
					const names = Object.keys(this.rates);
					return { filters: { name: ["in", names.length ? names : ["__no_rate__"]] } };
				},
				onchange: () => this.update_summary(),
			},
			{
				fieldname: "check_out",
				label: __("Check Out"),
				fieldtype: "Datetime",
				reqd: 1,
				onchange: () => this.update_summary(),
			},
			{ fieldtype: "Section Break", label: __("Items and Services"), collapsible: 1 },
			{
				fieldname: "items_and_service",
				fieldtype: "Table",
				label: __("Items and Services"),
				cannot_add_rows: false,
				in_place_edit: true,
				data: [],
				fields: [
					{
						fieldname: "item",
						label: __("Item"),
						fieldtype: "Link",
						options: "Item",
						in_list_view: 1,
						reqd: 1,
						columns: 5,
						get_query: () => ({ filters: { is_sales_item: 1, disabled: 0 } }),
						onchange: function () {
							// this — контрол ячейки, this.doc — строка таблицы
							me_ref.fetch_item_rate(this.doc);
						},
					},
					{
						fieldname: "qty",
						label: __("Qty"),
						fieldtype: "Float",
						in_list_view: 1,
						reqd: 1,
						default: 1,
						columns: 2,
						onchange: function () {
							me_ref.update_row(this.doc);
						},
					},
					{
						fieldname: "rate",
						label: __("Rate"),
						fieldtype: "Currency",
						in_list_view: 1,
						read_only: 1,
						columns: 3,
					},
					{
						fieldname: "price_list",
						label: __("Price List"),
						fieldtype: "Link",
						options: "Price List",
					},
				],
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
		this.load_price_list();
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

	// ---- товары и услуги --------------------------------------------------------

	async load_price_list() {
		this.price_list =
			(await frappe.db.get_single_value("Selling Settings", "selling_price_list")) ||
			"Standard Selling";
	}

	get items_grid() {
		return this.fields_dict.items_and_service && this.fields_dict.items_and_service.grid;
	}

	async fetch_item_rate(row) {
		if (!row) return;
		row.price_list = row.price_list || this.price_list;
		row.qty = row.qty || 1;
		row.rate = 0;
		if (row.item && row.price_list) {
			const r = await frappe.db.get_value(
				"Item Price",
				{ item_code: row.item, price_list: row.price_list, selling: 1 },
				"price_list_rate"
			);
			row.rate = flt(r.message && r.message.price_list_rate);
			if (!row.rate) {
				frappe.show_alert({
					message: __("No price for {0} in price list {1}", [row.item, row.price_list]),
					indicator: "orange",
				});
			}
		}
		this.update_row(row);
	}

	update_row(row) {
		if (row) row.amount = flt(row.rate) * flt(row.qty);
		this.items_grid && this.items_grid.refresh();
		this.update_summary();
	}

	items_total() {
		const rows = (this.items_grid && this.items_grid.get_data()) || [];
		return rows.reduce((sum, r) => sum + flt(r.rate) * flt(r.qty), 0);
	}

	update_doc() {
		super.update_doc();
		// в документ отдаём только нужные поля строк (без служебных name/idx диалога)
		const rows = (this.items_grid && this.items_grid.get_data()) || [];
		this.doc.items_and_service = rows
			.filter((r) => r.item)
			.map((r) => ({
				item: r.item,
				qty: flt(r.qty) || 1,
				rate: flt(r.rate),
				price_list: r.price_list || this.price_list,
			}));
		return this.doc;
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
		if (current && !(current in this.rates)) {
			await this.set_value("room_rate", "");
		}
		if (!this.get_value("room_rate") && names.length === 1) {
			await this.set_value("room_rate", names[0]);
		}
		if (room && !names.length && !initial) {
			frappe.show_alert({
				message: __("No active rates for this room type"),
				indicator: "orange",
			});
		}
		this.update_summary();
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
		const items = this.items_total();
		if (rate != null) {
			parts.push(`${format_currency(rate, currency)} / ${__("h")}`);
			if (items) parts.push(`${__("Items and Services")}: ${format_currency(items, currency)}`);
			parts.push(`<b>${format_currency(flt(rate * hours + items, 2), currency)}</b>`);
		}
		field.$wrapper.html(
			`<div class="text-muted" style="padding: 2px 0 6px">${parts.join(" · ")}</div>`
		);
	}
};
