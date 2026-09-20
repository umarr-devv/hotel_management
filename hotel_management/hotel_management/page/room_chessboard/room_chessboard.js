// Copyright (c) 2026, umarr and contributors
// For license information, please see license.txt
//
// CSS страницы лежит рядом (room_chessboard.css) — Frappe отдаёт его вместе со страницей,
// сборка ассетов для него не нужна. Быструю форму подключаем так же, через include.

{% include "hotel_management/public/js/room_booking_quick_entry.js" %}

(() => {
	frappe.pages["room-chessboard"].on_page_load = function (wrapper) {
		const page = frappe.ui.make_app_page({
			parent: wrapper,
			title: __("Room Chessboard"),
			single_column: true,
		});

		frappe
			.require([
				"/assets/hotel_management/js/lib/vis-timeline.min.js",
				"/assets/hotel_management/css/lib/vis-timeline.min.css",
			])
			.then(() => {
				wrapper.chessboard = new hotel_management.RoomChessboard(page, wrapper);
			});
	};

	frappe.pages["room-chessboard"].on_page_show = function (wrapper) {
		// вернулись с формы брони — подтягиваем свежие данные
		wrapper.chessboard && wrapper.chessboard.load_bookings();
	};

	frappe.provide("hotel_management");

	const API = "hotel_management.hotel_management.page.room_chessboard.room_chessboard";
	const HOUR = 60 * 60 * 1000;
	const DAY = 24 * HOUR;
	const DAY_WIDTH = 112; // ширина колонки дня, px
	const CHECK_IN_HOUR = 14;
	const CHECK_OUT_HOUR = 12;
	const SELECTION_ID = "__selection__";
	const VIEW_KEY = "room_chessboard_view";

	const STATUSES = ["Booking", "Checked In", "Checked Out", "Completed"];

	const VIEWS = {
		group: __("By Room Type"),
		building: __("By Building"),
		flat: __("All Rooms"),
	};

	// иконки (stroke = currentColor)
	const svg = (body, cls = "") =>
		`<svg class="rc-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor"
			stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
	const ICONS = {
		user: svg('<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>'),
		company: svg(
			'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 21v-4h6v4"/>' +
				'<path d="M8 7h.01M12 7h.01M16 7h.01M8 11h.01M12 11h.01M16 11h.01"/>'
		),
		unpaid: svg(
			'<rect x="2" y="6" width="20" height="12" rx="2"/><circle cx="12" cy="12" r="2"/>' +
				'<path d="M6 12h.01M18 12h.01"/>'
		),
		paid: svg('<circle cx="12" cy="12" r="9.5"/><path d="m8.5 12 2.5 2.5 4.5-5"/>'),
		prev: svg('<path d="M19 12H5M11 18l-6-6 6-6"/>'),
		next: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
		refresh: svg(
			'<path d="M20 11a8 8 0 0 0-14.3-4.3L4 8.5M4 4v4.5h4.5"/>' +
				'<path d="M4 13a8 8 0 0 0 14.3 4.3l1.7-1.8M20 20v-4.5h-4.5"/>'
		),
		add: svg(
			'<rect x="3" y="4.5" width="18" height="16.5" rx="2"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/>' +
				'<path d="M12 12.5v5M9.5 15h5"/>'
		),
		chevron: svg('<path d="m6 9 6 6 6-6"/>', "rc-chevron"),
	};

	hotel_management.RoomChessboard = class RoomChessboard {
		constructor(page, wrapper) {
			this.page = page;
			this.wrapper = $(wrapper);
			this.view = this.load_view();
			this.month = start_of_month(new Date());

			this.make_layout();
			this.make_timeline();
			this.setup_selection();
			this.setup_scrollbar();

			this.load_bookings = frappe.utils.debounce(this._load_bookings.bind(this), 200);
			this.go_to_month(this.month, new Date()).then(() => this.reload());
		}

		// ------------------------------------------------------------ layout

		make_layout() {
			const views = Object.entries(VIEWS)
				.map(([k, label]) => `<option value="${k}">${label}</option>`)
				.join("");

			const legend = STATUSES.map(
				(s) => `<span class="rc-legend-item">
					<span class="rc-dot rc-status-${slug(s)}"></span>${__(s)}
				</span>`
			).join("");

			this.$body = $(`
				<div class="rc">
					<div class="rc-toolbar">
						<div class="rc-field">
							<label>${__("Month")}</label>
							<div class="rc-month">
								<button class="btn btn-default rc-icon-btn" data-action="prev-month"
									title="${__("Previous Month")}">${ICONS.prev}</button>
								<button class="btn rc-month-label" data-action="today"
									title="${__("Today")}"></button>
								<button class="btn btn-default rc-icon-btn" data-action="next-month"
									title="${__("Next Month")}">${ICONS.next}</button>
							</div>
						</div>
						<div class="rc-field">
							<label>${__("View")}</label>
							<select class="form-control rc-view">${views}</select>
						</div>
						<button class="btn btn-default rc-icon-btn rc-refresh" data-action="refresh"
							title="${__("Refresh")}">${ICONS.refresh}</button>
						<button class="btn btn-primary rc-new" data-action="new">
							${ICONS.add}<span>${__("Booking")}</span>
						</button>
					</div>

					<div class="rc-board">
						<div class="rc-corner">
							<button class="rc-corner-toggle" data-action="toggle-all">
								${ICONS.chevron}<span>${__("Resources")}</span>
							</button>
						</div>
						<div class="rc-timeline"></div>
						<div class="rc-scrollbar"><div class="rc-scrollbar-thumb"></div></div>
					</div>

					<div class="rc-empty hidden">
						<p>${__("No rooms found")}</p>
						<a href="/app/hotel-room/new" class="btn btn-default btn-sm">${__("Create Hotel Room")}</a>
					</div>

					<div class="rc-legend">
						${legend}
						<span class="rc-legend-sep"></span>
						<span class="rc-legend-item rc-pay-unpaid">${ICONS.unpaid}${__("Unpaid")}</span>
						<span class="rc-legend-item rc-pay-paid">${ICONS.paid}${__("Paid")}</span>
					</div>
				</div>
			`).appendTo(this.page.main);

			this.$timeline = this.$body.find(".rc-timeline");
			this.$body.find(".rc-view").val(this.view);

			this.$body.on("click", "[data-action]", (e) => {
				const action = $(e.currentTarget).attr("data-action");
				if (action === "prev-month") this.shift_month(-1);
				else if (action === "next-month") this.shift_month(1);
				else if (action === "today")
					this.go_to_month(start_of_month(new Date()), new Date());
				else if (action === "refresh") this.reload();
				else if (action === "new") this.open_quick_entry({});
				else if (action === "toggle-all") this.toggle_all();
			});
			this.$body.on("change", ".rc-view", (e) => {
				this.view = $(e.currentTarget).val();
				this.save_view();
				this.set_groups(this.rooms || []);
			});

			$(window).on(
				"resize.room_chessboard",
				frappe.utils.debounce(() => this.fit(), 150)
			);
		}

		make_timeline() {
			this.groups = new vis.DataSet();
			this.items = new vis.DataSet();

			// start/end обязательны: иначе vis сама растянет окно на все брони при первой загрузке
			const start = start_of_day(new Date(Date.now() - 4 * DAY));
			this.timeline = new vis.Timeline(this.$timeline.get(0), this.items, this.groups, {
				start,
				end: new Date(start.getTime() + 14 * DAY),
				locale: (frappe.boot.lang || "en").split("-")[0],
				orientation: { axis: "top", item: "top" },
				timeAxis: { scale: "hour", step: 12 },
				showMajorLabels: false,
				format: { minorLabels: (date) => this.day_label(date) },
				stack: false,
				editable: false,
				selectable: false,
				moveable: true,
				zoomable: false,
				verticalScroll: true,
				horizontalScroll: false,
				showCurrentTime: true,
				groupOrder: "order",
				margin: { item: { horizontal: 0, vertical: 8 }, axis: 0 },
				maxHeight: this.available_height(),
				tooltip: { followMouse: true, overflowMethod: "flip", delay: 250 },
				xss: {
					disabled: false,
					filterOptions: {
						whiteList: {
							div: ["class"],
							span: ["class"],
							b: [],
							strong: [],
							mark: [],
							br: [],
						},
					},
				},
				template: (item, element, data) => this.item_template(data),
				groupTemplate: (group) => this.group_template(group),
			});

			this.timeline.on("rangechange", () => this.update_scrollbar());
			this.timeline.on("rangechanged", () => {
				this.update_scrollbar();
				// vis-timeline с заданными start/end показывает шкалу только после rangechanged
				// И следующей перерисовки; если окно сменили до первой отрисовки — перерисовываем
				if (!this.timeline.initialDrawDone) setTimeout(() => this.timeline.redraw(), 0);
			});
			this.timeline.on("changed", () => this.sync_corner());
			this.timeline.on("click", (props) => {
				const item = props.item && this.items.get(props.item);
				if (item && item.booking) {
					frappe.set_route("Form", "Room Booking", props.item);
				}
			});
		}

		// ------------------------------------------------------------ period

		shift_month(direction) {
			const month = new Date(this.month);
			month.setMonth(month.getMonth() + direction);
			return this.go_to_month(month);
		}

		go_to_month(month, focus) {
			this.month = start_of_month(month);
			const min = new Date(this.month);
			const max = new Date(this.month);
			max.setMonth(max.getMonth() + 1);
			max.setDate(max.getDate() + 7); // небольшой «хвост» следующего месяца
			this.bounds = { min, max };

			const span = this.visible_days() * DAY;
			let start = new Date(min);
			if (focus && focus >= min && focus < max) {
				start = new Date(focus);
				start.setHours(0, 0, 0, 0);
				start.setDate(start.getDate() - 4);
			}
			start = new Date(Math.max(min, Math.min(start, max - span)));

			this.timeline.setOptions({ min, max });
			this.set_window(start, new Date(start.getTime() + span));

			const label = moment(this.month).format("MMMM YYYY");
			this.$body.find(".rc-month-label").text(label.charAt(0).toUpperCase() + label.slice(1));

			return this.load_bookings_now();
		}

		set_window(start, end) {
			this.timeline.setWindow(start, end, { animation: false });
		}

		visible_days() {
			const width = this.$timeline.width() - this.left_width();
			return Math.max(3, Math.round(width / DAY_WIDTH));
		}

		left_width() {
			const left = this.$timeline.find(".vis-panel.vis-left").get(0);
			return left ? left.offsetWidth : 260;
		}

		fit() {
			this.timeline.setOptions({ maxHeight: this.available_height() });
			const win = this.timeline.getWindow();
			this.set_window(win.start, new Date(win.start.getTime() + this.visible_days() * DAY));
			this.sync_corner();
		}

		available_height() {
			const el = this.$timeline && this.$timeline.get(0);
			const top = el && el.offsetParent ? el.getBoundingClientRect().top : 240;
			return Math.max(360, window.innerHeight - top - 90);
		}

		// ------------------------------------------------------------ data

		reload() {
			return frappe
				.call({ method: `${API}.get_rooms` })
				.then((r) => this.set_groups(r.message || []))
				.then(() => this.load_bookings_now());
		}

		load_bookings_now() {
			return this._load_bookings();
		}

		_load_bookings() {
			if (!this.bounds) return Promise.resolve();
			const request_id = (this._request_id = (this._request_id || 0) + 1);
			return frappe
				.call({
					method: `${API}.get_bookings`,
					args: {
						start: format_dt(this.bounds.min),
						end: format_dt(this.bounds.max),
					},
				})
				.then((r) => {
					if (request_id !== this._request_id) return; // устаревший ответ
					this.set_items(r.message || []);
				});
		}

		set_groups(rooms) {
			this.rooms = rooms;
			const groups = [];
			const parents = new Map();

			const parent = (id, label, level, parent_group) => {
				if (!parents.has(id)) {
					const g = {
						id,
						kind: level === 0 ? "section" : "subsection",
						label,
						nestedGroups: [],
						showNested: true,
						order: groups.length,
						className: `rc-group-${level === 0 ? "section" : "subsection"}`,
					};
					parents.set(id, g);
					groups.push(g);
					parent_group && parent_group.nestedGroups.push(id);
				}
				return parents.get(id);
			};

			const sorted = [...rooms];
			if (this.view === "group") {
				sorted.sort(
					(a, b) =>
						natural_cmp(a.room_type, b.room_type) ||
						natural_cmp(room_sort_key(a), room_sort_key(b))
				);
			}

			sorted.forEach((room) => {
				let container = null;
				if (this.view === "group") {
					container = parent(`t::${room.room_type || ""}`, room.room_type || __("No Room Type"), 0);
				} else if (this.view === "building") {
					const b = parent(
						`b::${room.hotel_building || ""}`,
						room.hotel_building || __("No Building"),
						0
					);
					const floor_key = room.hotel_floor || String(room.floor_number || "");
					container = parent(
						`f::${room.hotel_building || ""}::${floor_key}`,
						floor_key ? __("Floor {0}", [room.floor_number || room.hotel_floor]) : __("No Floor"),
						1,
						b
					);
				}
				container && container.nestedGroups.push(room.name);
				groups.push({
					id: room.name,
					kind: "room",
					label: room_label(room),
					order: groups.length,
					className: "rc-group-room",
				});
			});

			// сохраняем свёрнутость групп
			groups.forEach((g) => {
				const old = this.groups.get(g.id);
				if (old && g.nestedGroups) g.showNested = old.showNested;
			});
			apply_visibility(groups);

			this.groups.clear();
			this.groups.add(groups);

			const has_rooms = rooms.length > 0;
			this.$body.find(".rc-empty").toggleClass("hidden", has_rooms);
			this.$body.find(".rc-board").toggleClass("hidden", !has_rooms);

			// ширина левой колонки известна только после отрисовки строк — пересчитываем окно
			setTimeout(() => this.fit(), 0);
		}

		set_items(bookings) {
			const items = bookings.map((b) => ({
				id: b.name,
				group: b.room,
				start: parse_dt(b.check_in),
				end: parse_dt(b.check_out),
				className: [
					"rc-item",
					`rc-status-${slug(b.status)}`,
					b.pay_status === "Paid" ? "rc-paid" : "rc-unpaid",
				].join(" "),
				title: this.tooltip_html(b),
				booking: b,
			}));

			items.push(...this.weekend_items());

			const keep = new Set(items.map((i) => i.id));
			keep.add(SELECTION_ID);
			this.items.remove(this.items.getIds().filter((id) => !keep.has(id)));
			this.items.update(items);
		}

		weekend_items() {
			// затенение выходных на всю высоту — фоновые элементы без группы
			const items = [];
			const day = new Date(this.bounds.min);
			while (day < this.bounds.max) {
				if ([0, 6].includes(day.getDay())) {
					items.push({
						id: `weekend::${format_dt(day)}`,
						start: new Date(day),
						end: new Date(day.getTime() + DAY),
						type: "background",
						className: "rc-weekend",
						content: "",
					});
				}
				day.setDate(day.getDate() + 1);
			}
			return items;
		}

		// ------------------------------------------------------------ templates

		day_label(date) {
			// подписи ставим на полдень — так число оказывается по центру колонки дня
			// vis-timeline на часовой шкале не помечает выходные/сегодня классами,
			// поэтому кодируем это тегом: <mark> — сегодня, <strong> — выходной, <b> — будни
			if (date.hours() !== 12) return "";
			const tag = date.isSame(moment(), "day") ? "mark" : [0, 6].includes(date.day()) ? "strong" : "b";
			return `<${tag}>${date.format("D")}</${tag}><br>${date.format("dd")}`;
		}

		group_template(group) {
			const el = document.createElement("div");
			el.className = `rc-group-label rc-group-label-${group.kind}`;
			if (group.nestedGroups) el.insertAdjacentHTML("beforeend", ICONS.chevron);
			const title = document.createElement("span");
			title.textContent = group.label;
			el.appendChild(title);
			return el;
		}

		item_template(item) {
			const el = document.createElement("div");
			el.className = "rc-item-content";

			if (item.type === "background") return "";
			if (item.id === SELECTION_ID) {
				el.textContent = item.label;
				return el;
			}

			const b = item.booking;
			el.insertAdjacentHTML("beforeend", b.customer_type === "Company" ? ICONS.company : ICONS.user);

			const title = document.createElement("span");
			title.className = "rc-item-title";
			title.textContent = b.customer_name || b.customer || b.name;
			el.appendChild(title);

			el.insertAdjacentHTML(
				"beforeend",
				`<span class="rc-item-pay">${b.pay_status === "Paid" ? ICONS.paid : ICONS.unpaid}</span>`
			);
			return el;
		}

		tooltip_html(b) {
			const esc = (v) => frappe.utils.escape_html(v == null ? "" : String(v));
			const fmt = (v) => moment(parse_dt(v)).format("DD.MM.YYYY HH:mm");
			const rows = [
				[__("Room"), b.room],
				[__("Check In"), fmt(b.check_in)],
				[__("Check Out"), fmt(b.check_out)],
				[__("Total Hours"), flt(b.total_hours, 1)],
				[__("Guests"), b.guests],
				[__("Status"), __(b.status)],
				[__("Pay Status"), __(b.pay_status || "Unpaid")],
				[__("Total"), format_currency(b.total_amount, b.currency)],
			];
			return `<div class="rc-tooltip">
				<div class="rc-tooltip-title"><b>${esc(b.customer_name || b.customer)}</b></div>
				<div class="rc-tooltip-sub">${esc(b.name)}</div>
				${rows
					.map(
						([label, value]) =>
							`<div class="rc-tooltip-row"><span>${esc(label)}</span><span>${esc(value)}</span></div>`
					)
					.join("")}
			</div>`;
		}

		// ------------------------------------------------------------ selection

		setup_selection() {
			const root = this.$timeline.get(0);

			const on_down = (e) => {
				if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
				const $t = $(e.target);
				if (!$t.closest(".vis-panel.vis-center").length || $t.closest(".vis-item:not(.vis-background)").length) return;

				const props = this.timeline.getEventProperties(e);
				const group = props.group != null && this.groups.get(props.group);
				if (!group || group.kind !== "room" || !props.time) return;

				// перехватываем событие до vis-timeline, чтобы вместо прокрутки было выделение
				e.stopPropagation();
				e.preventDefault();

				this.selection = { room: group.id, anchor: start_of_day(props.time) };
				this.selection.current = this.selection.anchor;
				this.render_selection();

				const on_move = (ev) => {
					const p = this.timeline.getEventProperties(ev);
					if (!p.time) return;
					const day = start_of_day(p.time);
					if (day.getTime() !== this.selection.current.getTime()) {
						this.selection.current = day;
						this.render_selection();
					}
				};
				const on_up = () => {
					window.removeEventListener("pointermove", on_move, true);
					window.removeEventListener("pointerup", on_up, true);
					this.finish_selection();
				};
				window.addEventListener("pointermove", on_move, true);
				window.addEventListener("pointerup", on_up, true);
			};

			// capture: срабатываем раньше обработчиков vis-timeline (они висят на дочернем элементе)
			root.addEventListener("pointerdown", on_down, true);
			root.addEventListener("mousedown", (e) => this.selection && e.stopPropagation(), true);
			root.addEventListener("touchstart", (e) => this.selection && e.stopPropagation(), true);
		}

		selection_range() {
			const { anchor, current } = this.selection;
			const first = new Date(Math.min(anchor, current));
			let last = new Date(Math.max(anchor, current));
			if (last.getTime() === first.getTime()) last = new Date(first.getTime() + DAY);

			const check_in = new Date(first);
			check_in.setHours(CHECK_IN_HOUR, 0, 0, 0);
			const check_out = new Date(last);
			check_out.setHours(CHECK_OUT_HOUR, 0, 0, 0);
			return [check_in, check_out];
		}

		render_selection() {
			const [start, end] = this.selection_range();
			const conflict = this.items.get({
				filter: (i) =>
					i.id !== SELECTION_ID && i.group === this.selection.room && i.start < end && i.end > start,
			}).length;
			const nights = Math.round((start_of_day(end) - start_of_day(start)) / DAY);

			this.selection.conflict = !!conflict;
			this.items.update({
				id: SELECTION_ID,
				group: this.selection.room,
				start,
				end,
				label: conflict
					? __("Room is occupied")
					: `${__("Nights: {0}", [nights])} · ${moment(start).format("DD.MM")} – ${moment(end).format("DD.MM")}`,
				className: `rc-selection ${conflict ? "rc-selection-conflict" : ""}`,
			});
		}

		finish_selection() {
			const selection = this.selection;
			if (!selection) return;

			if (selection.conflict) {
				frappe.show_alert({ message: __("Room is occupied for the selected dates"), indicator: "red" });
				this.clear_selection();
				return;
			}

			const [check_in, check_out] = this.selection_range();
			this.open_quick_entry(
				{ room: selection.room, check_in: format_dt(check_in), check_out: format_dt(check_out) },
				() => this.clear_selection()
			);
		}

		clear_selection() {
			this.selection = null;
			this.items.remove(SELECTION_ID);
		}

		open_quick_entry(values, on_close) {
			frappe.route_options = values;
			frappe.ui.form.make_quick_entry(
				"Room Booking",
				() => this.load_bookings_now(),
				(dialog) => {
					if (!on_close || !dialog.$wrapper) return;
					const prev = dialog.onhide;
					dialog.onhide = () => {
						prev && prev();
						on_close();
					};
				}
			);
			// если быстрая форма не открылась (полная форма) — снимаем выделение
			if (on_close) setTimeout(() => !frappe.quick_entry && on_close(), 1500);
		}

		// ------------------------------------------------------------ scrollbar & wheel

		setup_scrollbar() {
			const $bar = this.$body.find(".rc-scrollbar");
			const $thumb = $bar.find(".rc-scrollbar-thumb");

			const set_start = (start) => {
				const win = this.timeline.getWindow();
				const span = win.end - win.start;
				const { min, max } = this.bounds;
				start = Math.max(min.getTime(), Math.min(start, max.getTime() - span));
				this.timeline.setWindow(new Date(start), new Date(start + span), { animation: false });
			};
			const px_to_ms = (px) => {
				const { min, max } = this.bounds;
				return (px / $bar.width()) * (max - min);
			};

			$thumb.on("pointerdown", (e) => {
				e.preventDefault();
				const x0 = e.clientX;
				const start0 = this.timeline.getWindow().start.getTime();
				const move = (ev) => set_start(start0 + px_to_ms(ev.clientX - x0));
				const up = () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", up);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", up);
			});

			$bar.on("pointerdown", (e) => {
				if (e.target !== $bar.get(0)) return;
				const win = this.timeline.getWindow();
				const span = win.end - win.start;
				const offset = e.clientX - $bar.get(0).getBoundingClientRect().left;
				set_start(this.bounds.min.getTime() + px_to_ms(offset) - span / 2);
			});

			// горизонтальная прокрутка тачпадом или Shift + колесо
			this.$timeline.get(0).addEventListener(
				"wheel",
				(e) => {
					const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
					if (Math.abs(dx) <= Math.abs(e.shiftKey ? 0 : e.deltaY)) return;
					e.preventDefault();
					e.stopPropagation();
					const win = this.timeline.getWindow();
					const ms_per_px = (win.end - win.start) / (this.$timeline.width() - this.left_width());
					set_start(win.start.getTime() + dx * ms_per_px);
				},
				{ capture: true, passive: false }
			);
		}

		update_scrollbar() {
			if (!this.bounds) return;
			const { min, max } = this.bounds;
			const win = this.timeline.getWindow();
			const total = max - min;
			const left = ((win.start - min) / total) * 100;
			const width = ((win.end - win.start) / total) * 100;
			this.$body
				.find(".rc-scrollbar-thumb")
				.css({ left: `${Math.max(0, left)}%`, width: `${Math.min(100, width)}%` });
		}

		sync_corner() {
			const width = this.left_width();
			const top = this.$timeline.find(".vis-panel.vis-top").get(0);
			this.$body.find(".rc-corner").css({
				width: `${width}px`,
				height: `${top ? top.offsetHeight : 58}px`,
			});
			this.$body.find(".rc-scrollbar").css({ "margin-left": `${width}px` });
			// ширина колонки дня — для центрирования подписей в шапке
			const win = this.timeline.getWindow();
			const center = this.$timeline.width() - width;
			const day_px = (center / (win.end - win.start)) * DAY;
			this.$timeline.get(0).style.setProperty("--rc-day-w", `${day_px}px`);
		}

		toggle_all() {
			const parents = this.groups.get({ filter: (g) => g.nestedGroups });
			if (!parents.length) return;
			const expand = parents.some((g) => g.showNested === false);
			const groups = this.groups.get();
			groups.forEach((g) => g.nestedGroups && (g.showNested = expand));
			apply_visibility(groups);
			this.groups.update(groups.map((g) => ({ id: g.id, showNested: g.showNested, visible: g.visible })));
			this.$body.find(".rc-corner").toggleClass("collapsed", !expand);
		}

		// ------------------------------------------------------------ settings

		load_view() {
			try {
				const v = localStorage.getItem(VIEW_KEY);
				return VIEWS[v] ? v : "group";
			} catch (e) {
				return "group";
			}
		}

		save_view() {
			try {
				localStorage.setItem(VIEW_KEY, this.view);
			} catch (e) {
				// ignore
			}
		}
	};

	// ---------------------------------------------------------------- helpers
	// Даты в Frappe — «наивные» строки во временной зоне системы. Разбираем их как локальное
	// время браузера и так же собираем обратно, чтобы часы на шкале совпадали с формой брони.

	function parse_dt(value) {
		const [date, time = "00:00:00"] = String(value).split(" ");
		const [y, m, d] = date.split("-").map(Number);
		const [hh, mm, ss] = time.split(":").map((v) => parseInt(v, 10) || 0);
		return new Date(y, m - 1, d, hh, mm, ss);
	}

	function format_dt(date) {
		const pad = (n) => String(n).padStart(2, "0");
		return (
			`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
			`${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
		);
	}

	function start_of_day(date) {
		const d = new Date(date);
		d.setHours(0, 0, 0, 0);
		return d;
	}

	function start_of_month(date) {
		const d = start_of_day(date);
		d.setDate(1);
		return d;
	}

	// vis-timeline прячет вложенные группы флагом `visible`: группа видна, если все её
	// родители развёрнуты (showNested)
	function apply_visibility(groups) {
		const by_id = new Map(groups.map((g) => [g.id, g]));
		const parent_of = new Map();
		groups.forEach((g) => (g.nestedGroups || []).forEach((id) => parent_of.set(id, g.id)));
		groups.forEach((g) => {
			let visible = true;
			let pid = parent_of.get(g.id);
			while (pid != null) {
				const parent = by_id.get(pid);
				if (parent.showNested === false) visible = false;
				pid = parent_of.get(pid);
			}
			g.visible = visible;
		});
	}

	function room_label(room) {
		if (!room.room_type || !room.room_number) return room.name;
		// номер может уже содержать «№» — не дублируем
		const number = /^\d/.test(room.room_number) ? `№${room.room_number}` : room.room_number;
		return `${room.room_type} ${number}`;
	}

	function room_sort_key(room) {
		// «№7», «7», «VIP 7» → сортируем по самому номеру
		return String(room.room_number || room.name).replace(/^\D+/, "");
	}

	function natural_cmp(a, b) {
		return String(a || "").localeCompare(String(b || ""), undefined, { numeric: true });
	}

	function slug(value) {
		return String(value || "")
			.toLowerCase()
			.replace(/\s+/g, "-");
	}
})();
