// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Короткая форма (Quick Entry) для Room Booking: открывается из шахматки, из списка броней и
// через «Новый Room Booking». Общая логика диалога — в hotel_quick_entry.js.
//
// Подключение: файл вставляется через include в room_booking_list.js (Frappe выполняет его при
// загрузке меты Room Booking — до открытия быстрой формы) и в room_chessboard.js. JS DocType и
// страниц сервер отдаёт прямо из кода приложения, поэтому форма обновляется вместе с ним, без
// пересборки статики. Include стоит в комментарии, поэтому первая строка этого файла должна
// оставаться комментарием.
// {% include 'hotel_management/public/js/hotel_quick_entry.js' %}

frappe.ui.form.RoomBookingQuickEntryForm = class RoomBookingQuickEntryForm extends (
	frappe.ui.form.HotelQuickEntryForm
) {
	static FIELDS = ["customer", "room", "room_rate", "check_in", "check_out", "company", "hotel_profile"];

	constructor(...args) {
		super(...args);
		this.rates_by_room = {}; // номер -> Promise<{ тариф: цена за час }>
		// иначе полная форма «сменит» номер при открытии и сбросит выбранный тариф
		this.run_link_triggers = false;
	}

	get title() {
		return __("New Booking");
	}

	make_dialog() {
		super.make_dialog();
		this.dialog.$wrapper.addClass("room-booking-quick-entry");
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
			...this.more_information_fields(),
		];
	}

	async apply_initial_values(initial) {
		// тариф выставим, когда загрузятся тарифы номера
		this.pending_rate = initial.room_rate;
		delete initial.room_rate;
		await super.apply_initial_values(initial);
	}

	// профиль подставляем, только если он единственный
	async get_default_hotel_profile() {
		const profiles = await frappe.db.get_list("Hotel Profile", { limit: 2 });
		return profiles.length === 1 ? profiles[0].name : null;
	}

	// ------------------------------------------------------------ тарифы

	rates_for(room) {
		if (!room) return Promise.resolve({});
		if (!this.rates_by_room[room]) {
			this.rates_by_room[room] = frappe
				.xcall("hotel_management.api.get_room_rates", { room })
				.then((rows) => Object.fromEntries((rows || []).map((r) => [r.room_rate, flt(r.rate_per_day)])))
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

		// сумма считается так же, как в контроллере брони: цена за сутки × начатые сутки;
		// часы сначала округляются до точности поля total_hours, как на сервере
		const currency = frappe.defaults.get_default("currency");
		const float_precision = cint(frappe.boot.sysdefaults.float_precision) || 3;
		const days = Math.ceil(flt(hours, float_precision) / 24);
		const rate = room_rate ? rates[room_rate] : undefined;

		const parts = [`${__("Days")}: <b>${days}</b>`, `${__("Hours")}: <b>${flt(hours, 1)}</b>`];
		if (rate != null) {
			parts.push(
				`${__("Rate")}: ${format_currency(rate, currency)} / ${__("day")}`,
				`${__("Amount")}: <b>${format_currency(flt(rate * days, 2), currency)}</b>`
			);
		} else {
			parts.push(`${__("Amount")}: <b>—</b>`);
		}

		$summary.html(`<div class="text-muted" style="padding: 2px 0 6px">${parts.join(" · ")}</div>`);
	}

	// ------------------------------------------------------------ сохранение

	validate(values) {
		if (moment(values.check_out).diff(moment(values.check_in)) <= 0) {
			frappe.msgprint(__("Check Out must be after Check In"));
			return false;
		}
		return true;
	}

	saved_message(doc) {
		return __("Booking {0} saved", [doc.name]);
	}
};
