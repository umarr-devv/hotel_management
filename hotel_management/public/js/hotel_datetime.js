// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// Время заезда и выезда по умолчанию: день, выбранный в календаре поля Datetime, получает
// время 12:00. Время, набранное вручную, кнопка «Сейчас» и значения, подставленные кодом
// (например, выделение на шахматке), не меняются.
//
// Подключение: файл вставляется через include в комментарии, поэтому первая строка этого
// файла должна оставаться комментарием.
//
//   hotel_management.datetime.watch_day_pick(control)       — следить за выбором дня в календаре;
//   hotel_management.datetime.noon_if_day_picked(control, value) — значение с временем 12:00,
//                                                              если день только что выбрали, иначе null.

frappe.provide("hotel_management.datetime");

(() => {
	const DEFAULT_TIME = "12:00:00";
	// между щелчком по дню и change поля проходит обработка ввода — даём запас
	const PICK_TIMEOUT = 2000;

	const datetime = hotel_management.datetime;

	// щелчок по дню календаря (не по кнопке «Сейчас» и не по времени) запоминаем
	datetime.watch_day_pick = (control) => {
		if (!control || control.__hm_day_pick_watched) return;
		const bind = () => {
			const $picker = control.datepicker && control.datepicker.$datepicker;
			if (!$picker || control.__hm_day_pick_watched) return;
			control.__hm_day_pick_watched = true;
			$picker.on("pointerdown", ".datepicker--cell-day:not(.-disabled-)", () => {
				control.__hm_day_picked_at = Date.now();
			});
		};
		bind();
		// календарь создаётся вместе с полем ввода: если его ещё нет — ждём фокуса поля
		if (!control.__hm_day_pick_watched && control.$wrapper) control.$wrapper.one("focusin", bind);
	};

	datetime.noon_if_day_picked = (control, value) => {
		const picked_at = control && control.__hm_day_picked_at;
		if (!picked_at) return null;
		control.__hm_day_picked_at = null;
		if (!value || Date.now() - picked_at > PICK_TIMEOUT) return null;

		const [date, time] = String(value).split(" ");
		return time === DEFAULT_TIME ? null : `${date} ${DEFAULT_TIME}`;
	};
})();
