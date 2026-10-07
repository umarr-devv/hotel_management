// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Короткая форма (Quick Entry) для Hotel Expense.
//
// Frappe ищет класс по имени `<DocType без пробелов>QuickEntryForm` и открывает его вместо
// стандартной быстрой формы: из списка расходов и через «Новый Hotel Expense». Стандартная
// быстрая форма не умеет таблицы, а товары — обязательное поле расхода.
//
// Подключение: файл вставляется через include в hotel_expense_list.js (Frappe выполняет его при
// загрузке меты Hotel Expense — до открытия быстрой формы). Include стоит в комментарии,
// поэтому первая строка этого файла должна оставаться комментарием.
//
// Диалог — обычный frappe.ui.Dialog без привязки к Hotel Expense (как у быстрой формы брони),
// документ создаётся лишь при сохранении или переходе в полную форму.

frappe.provide("frappe.ui.form");

frappe.ui.form.HotelExpenseQuickEntryForm = class HotelExpenseQuickEntryForm {
	static FIELDS = ["supplier", "mode_of_payment", "notes", "company", "hotel_profile"];
	static ITEM_FIELDS = ["item", "qty", "rate"];
	// для precision(): строки диалога — простые объекты без doctype
	static ITEM_DOC = { doctype: "Hotel Expense Item" };
	static PAYMENT_MODE_QUERY =
		"hotel_management.hotel_management.doctype.hotel_profile.hotel_profile.payment_mode_query";

	constructor(doctype, after_insert, init_callback) {
		this.doctype = doctype;
		this.after_insert = after_insert;
		this.init_callback = init_callback;
	}

	setup() {
		// значения, переданные извне: фильтры списка
		const values = { ...(frappe.route_options || {}) };
		frappe.route_options = null;

		return new Promise((resolve) => {
			frappe.model.with_doctype(this.doctype, async () => {
				this.make_dialog();
				await this.set_initial_values(values);
				resolve(this);
			});
		});
	}

	// ------------------------------------------------------------ диалог

	make_dialog() {
		this.dialog = new frappe.ui.Dialog({
			title: __("New Hotel Expense"),
			size: "large",
			doc: {},
			fields: this.get_fields(),
			primary_action_label: __("Save"),
			primary_action: () => this.save(false),
		});
		this.dialog.add_custom_action(__("Save and Submit"), () => this.save(true));
		this.dialog.add_custom_action(__("Open Full Form"), () => this.open_full_form());
		this.dialog.onhide = () => (frappe.quick_entry = null);

		// Ctrl+Enter — сохранить, как в стандартной быстрой форме
		this.dialog.$wrapper.on("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				this.save(false);
			}
		});
		// удаление строк товаров не вызывает change — итог пересчитываем после клика
		this.dialog.fields_dict.items.$wrapper.on("click", ".grid-remove-rows, .grid-remove-all-rows", () =>
			setTimeout(() => this.update_summary(), 100)
		);

		this.dialog.show();
		this.init_callback && this.init_callback(this.dialog);
	}

	get_fields() {
		const me = this;
		return [
			{
				fieldname: "supplier",
				label: __("Supplier"),
				fieldtype: "Link",
				options: "Supplier",
				reqd: 1,
				bold: 1,
			},
			{ fieldtype: "Column Break" },
			{
				fieldname: "mode_of_payment",
				label: __("Mode of Payment"),
				fieldtype: "Link",
				options: "Mode of Payment",
				reqd: 1,
				get_query: () => ({
					query: HotelExpenseQuickEntryForm.PAYMENT_MODE_QUERY,
					filters: { hotel_profile: this.dialog.get_value("hotel_profile") || "" },
				}),
			},
			{ fieldtype: "Section Break", label: __("Items") },
			{
				fieldname: "items",
				fieldtype: "Table",
				label: __("Items"),
				reqd: 1,
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
						columns: 5,
						reqd: 1,
						get_query: () => ({ filters: { disabled: 0, is_purchase_item: 1 } }),
						onchange() {
							me.on_item_change(this);
						},
					},
					{
						fieldname: "qty",
						label: __("Qty"),
						fieldtype: "Float",
						in_list_view: 1,
						columns: 2,
						reqd: 1,
						default: 1,
						onchange() {
							me.update_row_amount(this);
						},
					},
					{
						fieldname: "rate",
						label: __("Rate"),
						fieldtype: "Currency",
						in_list_view: 1,
						columns: 2,
						reqd: 1,
						onchange() {
							me.update_row_amount(this);
						},
					},
					{
						fieldname: "amount",
						label: __("Amount"),
						fieldtype: "Currency",
						in_list_view: 1,
						columns: 1,
						read_only: 1,
					},
				],
			},
			{ fieldname: "summary", fieldtype: "HTML" },
			{ fieldtype: "Section Break" },
			{ fieldname: "notes", label: __("Notes"), fieldtype: "Small Text" },
			{ fieldtype: "Section Break", label: __("More Information"), collapsible: 1 },
			{
				fieldname: "hotel_profile",
				label: __("Hotel Profile"),
				fieldtype: "Link",
				options: "Hotel Profile",
				reqd: 1,
			},
			{ fieldtype: "Column Break" },
			{
				fieldname: "company",
				label: __("Company"),
				fieldtype: "Link",
				options: "Company",
				reqd: 1,
			},
		];
	}

	async set_initial_values(values) {
		const initial = {};
		for (const field of HotelExpenseQuickEntryForm.FIELDS) {
			if (values[field]) initial[field] = values[field];
		}
		await this.dialog.set_values(initial);
		await this.set_missing_defaults();
		this.update_summary();
	}

	async set_missing_defaults() {
		if (!this.dialog.get_value("company")) {
			const company =
				frappe.defaults.get_user_default("Company") || frappe.defaults.get_global_default("company");
			company && (await this.dialog.set_value("company", company));
		}
		if (!this.dialog.get_value("hotel_profile")) {
			// по умолчанию — первый профиль, разрешённый пользователю
			const profiles = await frappe.db.get_list("Hotel Profile", { order_by: "creation asc", limit: 1 });
			if (profiles.length) await this.dialog.set_value("hotel_profile", profiles[0].name);
		}
		// служебные поля заполнены — секцию можно не раскрывать
		this.toggle_more_information(!(this.dialog.get_value("company") && this.dialog.get_value("hotel_profile")));
	}

	toggle_more_information(show) {
		const section = this.dialog.fields_dict.company && this.dialog.fields_dict.company.section;
		section && section.collapse && section.collapse(!show);
	}

	// ------------------------------------------------------------ товары

	set_row_value(control, fieldname, value) {
		control.doc[fieldname] = value;
		control.grid_row && control.grid_row.refresh_field(fieldname);
	}

	async on_item_change(control) {
		const row = control.doc;
		const item = row && row.item;
		if (!item) return;

		// подсказываем цену последней закупки, как полная форма
		const { message } = await frappe.db.get_value("Item", item, "last_purchase_rate");
		if (row.item !== item) return; // товар сменили, пока шёл запрос
		if (!flt(row.qty)) this.set_row_value(control, "qty", 1);
		this.set_row_value(control, "rate", flt(message && message.last_purchase_rate));
		this.update_row_amount(control);
	}

	update_row_amount(control) {
		const row = control.doc;
		if (!row) return;
		const amount_precision = precision("amount", HotelExpenseQuickEntryForm.ITEM_DOC);
		this.set_row_value(control, "amount", flt(flt(row.qty) * flt(row.rate), amount_precision));
		this.update_summary();
	}

	get_items() {
		return (this.dialog.fields_dict.items.df.data || []).filter((row) => row.item);
	}

	update_summary() {
		const items = this.get_items();
		const total = items.reduce((sum, row) => sum + flt(row.qty) * flt(row.rate), 0);
		const currency = frappe.defaults.get_default("currency");
		this.dialog.fields_dict.summary.$wrapper.html(
			items.length
				? `<div class="text-muted text-right" style="padding: 2px 0 6px">
					${__("Total Amount")}: <b>${format_currency(total, currency)}</b></div>`
				: ""
		);
	}

	// ------------------------------------------------------------ сохранение

	make_doc(values) {
		frappe.route_options = null; // иначе get_new_doc подставит их ещё раз
		const doc = frappe.model.get_new_doc(this.doctype);
		for (const field of HotelExpenseQuickEntryForm.FIELDS) {
			if (values[field]) doc[field] = values[field];
		}
		// суммы сервер пересчитает сам; здесь — чтобы полная форма открылась с ними
		let total = 0;
		for (const row of this.get_items()) {
			const child = frappe.model.add_child(doc, "Hotel Expense Item", "items");
			for (const field of HotelExpenseQuickEntryForm.ITEM_FIELDS) child[field] = row[field];
			child.amount = flt(flt(child.qty) * flt(child.rate), precision("amount", child));
			total += child.amount;
		}
		doc.total_amount = flt(total, precision("total_amount", doc));
		return doc;
	}

	clear_doc(doc) {
		for (const row of doc.items || []) frappe.model.clear_doc(row.doctype, row.name);
		frappe.model.clear_doc(doc.doctype, doc.name);
	}

	async save(submit) {
		if (this.saving) return;

		const values = this.dialog.get_values(); // сам проверит обязательные поля
		if (!values) {
			if (!this.dialog.get_value("company") || !this.dialog.get_value("hotel_profile")) {
				this.toggle_more_information(true);
			}
			return;
		}
		if (!this.get_items().length) {
			frappe.msgprint(__("Add at least one item"));
			return;
		}

		const doc = this.make_doc(values);
		this.saving = true;
		this.dialog.disable_primary_action();
		try {
			let saved = await frappe.xcall("frappe.client.save", { doc });
			if (submit) saved = await this.submit(saved);
			this.dialog.hide();
			frappe.show_alert({
				message: saved.docstatus === 1
					? __("Hotel Expense {0} submitted", [saved.name])
					: __("Hotel Expense {0} saved", [saved.name]),
				indicator: "green",
			});
			this.after_save(saved);
		} catch (e) {
			// ошибку Frappe уже показал — форма остаётся открытой
		} finally {
			this.clear_doc(doc);
			this.saving = false;
			this.dialog.enable_primary_action();
		}
	}

	async submit(saved) {
		try {
			return await frappe.xcall("frappe.client.submit", { doc: saved });
		} catch (e) {
			// черновик уже сохранён: открываем его, чтобы исправить и провести из полной формы
			this.dialog.hide();
			frappe.set_route("Form", this.doctype, saved.name);
			throw e;
		}
	}

	after_save(doc) {
		if (frappe._from_link) {
			frappe.ui.form.update_calling_link(doc);
		} else if (this.after_insert) {
			this.after_insert(doc);
		} else {
			// как стандартная быстрая форма: со списка расходов остаёмся в списке
			const route = frappe.get_route() || [];
			if (!(route[0] === "List" && route[1] === this.doctype)) {
				frappe.set_route("Form", this.doctype, doc.name);
			}
		}
	}

	open_full_form() {
		const doc = this.make_doc(this.dialog.get_values(true) || {});
		this.dialog.hide();
		frappe.set_route("Form", this.doctype, doc.name);
	}
};
