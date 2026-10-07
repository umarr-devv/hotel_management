// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Общая основа коротких форм (Quick Entry) отеля: Room Booking, Hotel Expense.
//
// Frappe ищет класс по имени `<DocType без пробелов>QuickEntryForm` и открывает его вместо
// стандартной быстрой формы. Стандартная QuickEntryForm подменяет описания полей описаниями из
// DocType (у полей пропадали обработчики) и не умеет таблицы, поэтому здесь диалог — обычный
// frappe.ui.Dialog со своими полями, а документ создаётся лишь при сохранении или переходе в
// полную форму.
//
// Подключение: файл вставляется через include в начало файла быстрой формы. Include стоит в
// комментарии, поэтому первая строка этого файла должна оставаться комментарием.
//
// Подкласс задаёт:
//   static FIELDS        — поля диалога, которые переносятся в документ;
//   get title()          — заголовок диалога;
//   get_fields()         — поля диалога (секцию «Дополнительно» даёт more_information_fields());
//   saved_message(doc)   — текст уведомления после сохранения;
// и при необходимости переопределяет хуки: apply_initial_values, update_summary, validate,
// fill_doc, get_default_hotel_profile.

frappe.provide("frappe.ui.form");

frappe.ui.form.HotelQuickEntryForm = class HotelQuickEntryForm {
	static FIELDS = [];

	constructor(doctype, after_insert, init_callback) {
		this.doctype = doctype;
		this.after_insert = after_insert;
		this.init_callback = init_callback;
		this.dialog_size = null; // null — обычный размер диалога
		this.run_link_triggers = true; // запускать ли триггеры ссылок при открытии полной формы
	}

	setup() {
		// значения, переданные извне: выделение на шахматке, фильтры списка
		const values = { ...(frappe.route_options || {}) };
		frappe.route_options = null;

		return new Promise((resolve) => {
			frappe.model.with_doctype(this.doctype, async () => {
				this.make_dialog();
				try {
					await this.set_initial_values(values);
				} finally {
					// показываем, когда значения подставлены: Frappe раскрывает сворачиваемую
					// секцию, пока в ней есть пустые обязательные поля, — иначе «Дополнительно»
					// мелькнёт раскрытой и свернётся после загрузки значений по умолчанию
					this.show_dialog();
				}
				resolve(this);
			});
		});
	}

	// ------------------------------------------------------------ диалог

	make_dialog() {
		this.dialog = new frappe.ui.Dialog({
			title: this.title,
			size: this.dialog_size,
			// своё хранилище значений без doctype: Frappe проверяет по нему обязательные поля
			// в сворачиваемой секции, но не ищет для полей описаний в мете
			doc: {},
			fields: this.get_fields(),
			primary_action_label: __("Save"),
			primary_action: () => this.save(),
		});
		this.dialog.add_custom_action(__("Open Full Form"), () => this.open_full_form());
		this.dialog.onhide = () => (frappe.quick_entry = null);

		// Ctrl+Enter — сохранить, как в стандартной быстрой форме
		this.dialog.$wrapper.on("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				this.save();
			}
		});
	}

	show_dialog() {
		this.dialog.show();
		this.init_callback && this.init_callback(this.dialog);
	}

	// служебные поля: обычно заполняются сами, поэтому секция свёрнута
	more_information_fields() {
		return [
			{ fieldtype: "Section Break", label: __("More Information"), collapsible: 1 },
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

	// ------------------------------------------------------------ начальные значения

	async set_initial_values(values) {
		const initial = {};
		for (const field of this.constructor.FIELDS) {
			if (values[field]) initial[field] = values[field];
		}
		await this.apply_initial_values(initial);
		await this.set_missing_defaults();
		this.update_summary();
	}

	async apply_initial_values(initial) {
		await this.dialog.set_values(initial);
	}

	async set_missing_defaults() {
		if (!this.dialog.get_value("company")) {
			const company =
				frappe.defaults.get_user_default("Company") || frappe.defaults.get_global_default("company");
			company && (await this.dialog.set_value("company", company));
		}
		if (!this.dialog.get_value("hotel_profile")) {
			const profile = await this.get_default_hotel_profile();
			profile && (await this.dialog.set_value("hotel_profile", profile));
		}
		// служебные поля заполнены — секцию можно не раскрывать
		this.toggle_more_information(!this.has_more_information());
	}

	// по умолчанию — первый профиль, разрешённый пользователю
	async get_default_hotel_profile() {
		const profiles = await frappe.db.get_list("Hotel Profile", { order_by: "creation asc", limit: 1 });
		return profiles.length ? profiles[0].name : null;
	}

	has_more_information() {
		return !!(this.dialog.get_value("company") && this.dialog.get_value("hotel_profile"));
	}

	toggle_more_information(show) {
		const section = this.dialog.fields_dict.company && this.dialog.fields_dict.company.section;
		section && section.collapse && section.collapse(!show);
	}

	update_summary() {}

	// ------------------------------------------------------------ сохранение

	// дополнительные проверки перед сохранением; false — не сохранять
	validate(values) {
		return true;
	}

	make_doc(values) {
		frappe.route_options = null; // иначе get_new_doc подставит их ещё раз
		const doc = frappe.model.get_new_doc(this.doctype);
		for (const field of this.constructor.FIELDS) {
			if (values[field]) doc[field] = values[field];
		}
		this.fill_doc(doc);
		return doc;
	}

	// дочерние таблицы и расчётные поля документа
	fill_doc(doc) {}

	clear_doc(doc) {
		for (const value of Object.values(doc)) {
			if (!Array.isArray(value)) continue;
			for (const row of value) row && row.doctype && frappe.model.clear_doc(row.doctype, row.name);
		}
		frappe.model.clear_doc(doc.doctype, doc.name);
	}

	async save(submit = false) {
		if (this.saving) return;

		const values = this.dialog.get_values(); // сам проверит обязательные поля
		if (!values) {
			if (!this.has_more_information()) this.toggle_more_information(true);
			return;
		}
		if (!this.validate(values)) return;

		const doc = this.make_doc(values);
		this.saving = true;
		this.dialog.disable_primary_action();
		try {
			let saved = await frappe.xcall("frappe.client.save", { doc });
			if (submit) saved = await this.submit(saved);
			this.dialog.hide();
			frappe.show_alert({ message: this.saved_message(saved), indicator: "green" });
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
			// как стандартная быстрая форма: со списка остаёмся в списке
			const route = frappe.get_route() || [];
			if (!(route[0] === "List" && route[1] === this.doctype)) {
				frappe.set_route("Form", this.doctype, doc.name);
			}
		}
	}

	open_full_form() {
		const doc = this.make_doc(this.dialog.get_values(true) || {});
		if (!this.run_link_triggers) doc.__run_link_triggers = false;
		this.dialog.hide();
		frappe.set_route("Form", this.doctype, doc.name);
	}
};
