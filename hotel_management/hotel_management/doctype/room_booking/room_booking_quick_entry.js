// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Короткая форма (Quick Entry) для Room Booking.
//
// Frappe ищет класс по имени `<DocType без пробелов>QuickEntryForm` и открывает его вместо
// стандартной быстрой формы: из шахматки, из списка броней и через «Новый Room Booking».
//
// Подключение: файл вставляется через include в room_booking_list.js (Frappe выполняет его при
// загрузке меты Room Booking — до открытия быстрой формы) и в room_chessboard.js. JS DocType и
// страниц сервер отдаёт прямо из кода приложения, поэтому форма обновляется вместе с ним, без
// пересборки статики. Include стоит в комментарии, поэтому первая строка этого файла должна
// оставаться комментарием.
//
// Диалог — обычный frappe.ui.Dialog без привязки к Room Booking. Стандартная QuickEntryForm
// подменяет описания полей описаниями из DocType: у полей пропадали обработчики (сумма не
// пересчитывалась), а список тарифов попадал в мету и ломал полную форму. Здесь поля только
// свои, документ создаётся лишь при сохранении или переходе в полную форму.

frappe.provide("frappe.ui.form");

frappe.ui.form.RoomBookingQuickEntryForm = class RoomBookingQuickEntryForm {
	static FIELDS = ["customer", "room", "room_rate", "check_in", "check_out", "company", "hotel_profile"];

	constructor(doctype, after_insert, init_callback) {
		this.doctype = doctype;
		this.after_insert = after_insert;
		this.init_callback = init_callback;
		this.rates_by_room = {}; // номер -> Promise<{ тариф: цена за час }>
	}

	setup() {
		// значения, переданные извне: выделение на шахматке, фильтры списка
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
			title: __("New Booking"),
			// своё хранилище значений без doctype: Frappe проверяет по нему обязательные поля
			// в сворачиваемой секции, но не ищет для полей описаний в мете
			doc: {},
			fields: this.get_fields(),
			primary_action_label: __("Save"),
			primary_action: () => this.save(),
		});
		this.dialog.add_custom_action(__("Open Full Form"), () => this.open_full_form());
		this.dialog.$wrapper.addClass("room-booking-quick-entry");
		this.dialog.onhide = () => (frappe.quick_entry = null);

		// Ctrl+Enter — сохранить, как в стандартной быстрой форме
		this.dialog.$wrapper.on("keydown", (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				this.save();
			}
		});

		this.dialog.show();
		this.init_callback && this.init_callback(this.dialog);
	}

	get_fields() {
		return [
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
				// без отключённых номеров и номеров отключённых типов
				get_query: () => ({ query: "hotel_management.api.active_room_query" }),
				change: () => this.on_room_change(),
			},
			{
				fieldname: "check_in",
				label: __("Check In"),
				fieldtype: "Datetime",
				reqd: 1,
				change: () => this.update_summary(),
			},
			{ fieldtype: "Column Break" },
			{
				// только тарифы типа выбранного номера (Select, а не Link: в Link можно
				// вписать любой тариф вручную)
				fieldname: "room_rate",
				label: __("Room Rate"),
				fieldtype: "Select",
				options: "",
				reqd: 1,
				description: __("Select a room first"),
				change: () => this.update_summary(),
			},
			{
				fieldname: "check_out",
				label: __("Check Out"),
				fieldtype: "Datetime",
				reqd: 1,
				change: () => this.update_summary(),
			},
			{ fieldtype: "Section Break" },
			{ fieldname: "summary", fieldtype: "HTML" },
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

	async set_initial_values(values) {
		const initial = {};
		for (const field of RoomBookingQuickEntryForm.FIELDS) {
			if (values[field]) initial[field] = values[field];
		}
		// тариф выставим, когда загрузятся тарифы номера
		this.pending_rate = initial.room_rate;
		delete initial.room_rate;

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
			// если профиль отеля один — подставляем его
			const profiles = await frappe.db.get_list("Hotel Profile", { limit: 2 });
			if (profiles.length === 1) await this.dialog.set_value("hotel_profile", profiles[0].name);
		}
		// служебные поля заполнены — секцию можно не раскрывать
		this.toggle_more_information(!(this.dialog.get_value("company") && this.dialog.get_value("hotel_profile")));
	}

	toggle_more_information(show) {
		const section = this.dialog.fields_dict.company && this.dialog.fields_dict.company.section;
		section && section.collapse && section.collapse(!show);
	}

	// ------------------------------------------------------------ тарифы

	rates_for(room) {
		if (!room) return Promise.resolve({});
		if (!this.rates_by_room[room]) {
			this.rates_by_room[room] = frappe
				.xcall("hotel_management.api.get_room_rates", { room })
				.then((rows) => Object.fromEntries((rows || []).map((r) => [r.room_rate, flt(r.rate_by_hour)])))
				.catch((e) => {
					delete this.rates_by_room[room]; // при следующем обращении попробуем снова
					throw e;
				});
		}
		return this.rates_by_room[room];
	}

	async on_room_change() {
		const room = this.dialog.get_value("room");
		const rates = await this.rates_for(room).catch(() => ({}));
		// номер сменили, пока загружались тарифы — ответ уже не нужен
		if (room !== this.dialog.get_value("room")) return;

		const names = Object.keys(rates);
		const current = this.pending_rate || this.dialog.get_value("room_rate");
		this.pending_rate = null;

		const field = this.dialog.fields_dict.room_rate;
		field.df.options = [""].concat(names).join("\n");
		field.df.description = !room
			? __("Select a room first")
			: names.length
			? ""
			: __("No active rates for this room type");
		field.refresh();

		// тариф оставляем, если он есть у нового номера; единственный — подставляем сразу
		const rate = names.includes(current) ? current : names.length === 1 ? names[0] : "";
		await this.dialog.set_value("room_rate", rate);

		if (room && !names.length) {
			frappe.show_alert({ message: __("No active rates for this room type"), indicator: "orange" });
		}
		this.update_summary();
	}

	// ------------------------------------------------------------ сумма

	current_values() {
		const values = {};
		for (const field of ["room", "room_rate", "check_in", "check_out"]) {
			values[field] = this.dialog.get_value(field) || "";
		}
		return values;
	}

	async update_summary() {
		const $summary = this.dialog.fields_dict.summary.$wrapper;
		const values = this.current_values();
		const { room, room_rate, check_in, check_out } = values;

		if (!check_in || !check_out) {
			$summary.html("");
			return;
		}

		const hours = moment(check_out).diff(moment(check_in), "hours", true);
		if (isNaN(hours)) {
			$summary.html("");
			return;
		}
		if (hours <= 0) {
			$summary.html(`<div class="text-danger small">${__("Check Out must be after Check In")}</div>`);
			return;
		}

		const rates = await this.rates_for(room).catch(() => ({}));
		// пока загружались тарифы, значения могли поменяться — тогда отрисует следующий вызов
		const now = this.current_values();
		if (Object.keys(values).some((field) => values[field] !== now[field])) return;

		// сумма считается так же, как в контроллере брони: цена за час × часы
		const currency = frappe.defaults.get_default("currency");
		const nights = moment(check_out).startOf("day").diff(moment(check_in).startOf("day"), "days");
		const rate = room_rate ? rates[room_rate] : undefined;

		const parts = [`${__("Nights")}: <b>${nights}</b>`, `${__("Hours")}: <b>${flt(hours, 1)}</b>`];
		if (rate != null) {
			parts.push(
				`${__("Rate")}: ${format_currency(rate, currency)} / ${__("h")}`,
				`${__("Amount")}: <b>${format_currency(flt(rate * hours, 2), currency)}</b>`
			);
		} else {
			parts.push(`${__("Amount")}: <b>—</b>`);
		}

		$summary.html(`<div class="text-muted" style="padding: 2px 0 6px">${parts.join(" · ")}</div>`);
	}

	// ------------------------------------------------------------ сохранение

	make_doc(values) {
		frappe.route_options = null; // иначе get_new_doc подставит их ещё раз
		const doc = frappe.model.get_new_doc(this.doctype);
		for (const field of RoomBookingQuickEntryForm.FIELDS) {
			if (values[field]) doc[field] = values[field];
		}
		return doc;
	}

	async save() {
		if (this.saving) return;

		const values = this.dialog.get_values(); // сам проверит обязательные поля
		if (!values) {
			if (!this.dialog.get_value("company") || !this.dialog.get_value("hotel_profile")) {
				this.toggle_more_information(true);
			}
			return;
		}
		if (moment(values.check_out).diff(moment(values.check_in)) <= 0) {
			frappe.msgprint(__("Check Out must be after Check In"));
			return;
		}

		const doc = this.make_doc(values);
		this.saving = true;
		this.dialog.disable_primary_action();
		try {
			const saved = await frappe.xcall("frappe.client.save", { doc });
			this.dialog.hide();
			frappe.show_alert({ message: __("Booking {0} saved", [saved.name]), indicator: "green" });
			this.after_save(saved);
		} catch (e) {
			// ошибку (пересечение броней и т. п.) Frappe уже показал — форма остаётся открытой
		} finally {
			frappe.model.clear_doc(doc.doctype, doc.name);
			this.saving = false;
			this.dialog.enable_primary_action();
		}
	}

	after_save(doc) {
		if (frappe._from_link) {
			frappe.ui.form.update_calling_link(doc);
		} else if (this.after_insert) {
			this.after_insert(doc);
		} else {
			// как стандартная быстрая форма: со списка броней остаёмся в списке
			const route = frappe.get_route() || [];
			if (!(route[0] === "List" && route[1] === this.doctype)) {
				frappe.set_route("Form", this.doctype, doc.name);
			}
		}
	}

	open_full_form() {
		const doc = this.make_doc(this.dialog.get_values(true) || {});
		// иначе форма «сменит» номер при открытии и сбросит выбранный тариф
		doc.__run_link_triggers = false;
		this.dialog.hide();
		frappe.set_route("Form", this.doctype, doc.name);
	}
};
