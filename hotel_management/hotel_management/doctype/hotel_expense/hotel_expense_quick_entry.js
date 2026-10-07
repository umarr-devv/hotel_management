// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Короткая форма (Quick Entry) для Hotel Expense: открывается из списка расходов и через
// «Новый Hotel Expense». Стандартная быстрая форма не умеет таблицы, а товары — обязательное
// поле расхода. Общая логика диалога — в hotel_quick_entry.js.
//
// Подключение: файл вставляется через include в hotel_expense_list.js (Frappe выполняет его при
// загрузке меты Hotel Expense — до открытия быстрой формы). Include стоит в комментарии,
// поэтому первая строка этого файла должна оставаться комментарием.
// {% include 'hotel_management/public/js/hotel_quick_entry.js' %}

frappe.ui.form.HotelExpenseQuickEntryForm = class HotelExpenseQuickEntryForm extends (
	frappe.ui.form.HotelQuickEntryForm
) {
	static FIELDS = ["supplier", "mode_of_payment", "notes", "company", "hotel_profile"];
	static ITEM_FIELDS = ["item", "qty", "rate"];
	// для precision(): строки диалога — простые объекты без doctype
	static ITEM_DOC = { doctype: "Hotel Expense Item" };
	static PAYMENT_MODE_QUERY =
		"hotel_management.hotel_management.doctype.hotel_profile.hotel_profile.payment_mode_query";

	constructor(...args) {
		super(...args);
		this.dialog_size = "large";
	}

	get title() {
		return __("New Hotel Expense");
	}

	make_dialog() {
		super.make_dialog();
		this.dialog.add_custom_action(__("Save and Submit"), () => this.save(true));
		// удаление строк товаров не вызывает change — итог пересчитываем после клика
		this.dialog.fields_dict.items.$wrapper.on("click", ".grid-remove-rows, .grid-remove-all-rows", () =>
			setTimeout(() => this.update_summary(), 100)
		);
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
			...this.more_information_fields(),
		];
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

	validate() {
		if (!this.get_items().length) {
			frappe.msgprint(__("Add at least one item"));
			return false;
		}
		return true;
	}

	fill_doc(doc) {
		// суммы сервер пересчитает сам; здесь — чтобы полная форма открылась с ними
		let total = 0;
		for (const row of this.get_items()) {
			const child = frappe.model.add_child(doc, "Hotel Expense Item", "items");
			for (const field of HotelExpenseQuickEntryForm.ITEM_FIELDS) child[field] = row[field];
			child.amount = flt(flt(child.qty) * flt(child.rate), precision("amount", child));
			total += child.amount;
		}
		doc.total_amount = flt(total, precision("total_amount", doc));
	}

	saved_message(doc) {
		return doc.docstatus === 1
			? __("Hotel Expense {0} submitted", [doc.name])
			: __("Hotel Expense {0} saved", [doc.name]);
	}
};
