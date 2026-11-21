#!/usr/bin/env node
// Проверка тестов уведомлений мутациями: «вернули старое поведение — тест обязан покраснеть».
//
// Каждая мутация — одна точечная правка notify.mjs, возвращающая поведение, которое аудит
// уведомлений от 10.10.2026 признал ошибкой, либо механику прежнего набора правил v1 (часы
// удержания, «второй снимок», полы одним снимком, одно окно MVRV), снятую выпуском 2.15.0. Мутация применяется к КОПИИ во временном каталоге,
// рядом кладётся notify-test.mjs, тесты запускаются там. Мутация «убита», если тесты упали и среди
// упавших есть тот, что стережёт именно эту гарантию. Выжившая мутация — дыра в тестах.
//
// Запуск: node scripts/notify-mutation.mjs [часть-идентификатора]
// В рабочую копию ничего не пишет, в сеть не ходит. В notify.yml не входит: это инструмент
// разработчика, а не шаг рассылки (три десятка прогонов тестов на каждый снимок были бы лишними).
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, symlinkSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const source = readFileSync(join(here, "notify.mjs"), "utf8");
const tests = readFileSync(join(here, "notify-test.mjs"), "utf8");

// find — фрагмент исходника (обязан встретиться ровно один раз), put — на что он меняется,
// guard — образец имени теста, который должен упасть.
const MUTATIONS = [
  // --- п. 1: причина смены доли ---
  { id: "1-журнал-не-читается", find: "  } else if (last.cause?.text && !fs) {\n    const since", put: "  } else if (false) {\n    const since",
    guard: /причина смены доли берётся из журнала монитора/ },
  { id: "1-рождение-кандидата-не-читается", find: "const bc = live && feed.birth && feed.birth.candidate === last.regime_to ? birthCause(feed.birth, detName) : null;", put: "const bc = null;",
    guard: /без журнала причина строится из записи о рождении кандидата/ },
  { id: "1-причина-из-соседнего-снимка", find: 'causes.push(!v3 ? "Причина: смена режима" : !regimeUp ? "Причина: смена режима на суточном фиксе" : heldFull ? "Причина: смена режима, подтверждённая на втором фиксе подряд" : "Причина: смена режима");',
    put: 'causes.push("Причина: " + (why.map((w) => (w.worse ? "Ухудшился: " : "Улучшился: ") + w.name).join("; ") || "нет"));',
    guard: /без журнала и без записи о рождении причина не выдумывается/ },
  { id: "1-причина-оверлея-только-из-журнала", find: "  } else if (oc?.text && !regimeMoved) {", put: "  } else if (false) {",
    guard: /смена одного оверлея объясняется со снимка и при журнале монитора/ },
  { id: "1-входы-оверлея-без-журнала", find: "    logFamilies: live && last.cause?.families?.length ? last.cause.families : null,", put: "    logFamilies: null,",
    guard: /смена одного оверлея объясняется со снимка и при журнале монитора/ },
  // --- п. 2: самодостаточное сообщение ---
  { id: "2-откат-в-ту-же-сторону", find: "const o = agrees ? regimeShifts(eng, -1)[0] : null;", put: "const o = agrees ? regimeShifts(eng, +1)[0] : null;",
    guard: /повышение по режиму: было → стало, цена, режим, действие и условие отката ВНИЗ/ },
  { id: "2-без-цены", find: '    detail: finite(last.price) ? `BTC ${fmtUsd(last.price)}` : "",', put: '    detail: "",',
    guard: /повышение по режиму: было → стало, цена, режим/ },
  // время шага цели — в подвале (стандарт сообщений 29.10.2026): без него там стояло бы время прогона
  { id: "2-без-времени-шага", find: "    at: last.t,\n", put: "",
    guard: /смена одного оверлея объясняется со снимка и при журнале монитора/ },
  { id: "2-правило-исполнения-перепутано", find: "    else if (dir > 0) todo.push(next ?", put: "    else if (dir < 0 && false) todo.push(next ?",
    guard: /повышение по режиму: было → стало, цена, режим/ },
  { id: "2-возврат-без-срока", find: "  const up = engineAgrees(eng) && eng.candidate === eng.state ? regimeShifts(eng, +1)[0] : null;", put: "  const up = null; return [];",
    guard: /понижение по режиму: исполнять сразу, возврат — не раньше второго фикса подряд/ },
  { id: "2-оверлей-не-назван", find: "  if (on) {\n    const rung", put: "  if (false) {\n    const rung",
    guard: /пол восстановления назван полом/ },
  { id: "2-пол-судится-как-режим", find: '    if (eng.overlays.includes("recovery_floor")) return [floorExitLine(eng)];', put: "",
    guard: /пол восстановления назван полом/ },
  { id: "2-аварийный-режим-как-обычная-смена", find: "  const emergencyOn = eng.emergency;", put: "  const emergencyOn = false;",
    guard: /аварийный режим — отдельное сообщение/ },
  { id: "2-шаблон-по-знаку-смены", find: '  if (ev.kind === "allocation" && ev.facts) {', put: '  if (ev.kind === "allocation" && ev.facts && false) {',
    guard: /снятие пола из-за роста оценки не подаётся как «обстановка хуже прежней»/ },
  // --- п. 3: кандидат и ожидание второго фикса ---
  { id: "3-идущее-понижение-не-видно", find: "  if (severity(c) >= severity(eng.state)) return null;\n  const next = targetOf", put: "  return null;\n  const next = targetOf",
    guard: /сообщение о снятии аварийного режима между фиксами предупреждает об идущем понижении/ },
  { id: "3-каждый-срыв-ожидания-шлётся", find: "  if (track && track.state === eng.state && finite(toldAt) && eng.t - toldAt < HOLD_RESET_REPEAT_MS) {", put: "  if (false) {",
    guard: /срыв ожидания: «кандидат не подтвердился на втором фиксе» — одно сообщение на эпизод/ },
  { id: "3-срывы-ожидания-молчат", find: "    const reset = holdResetEvent(shared);\n    if (reset) out.push(reset);", put: "",
    guard: /срыв ожидания: «кандидат не подтвердился на втором фиксе» — одно сообщение на эпизод/ },
  { id: "3-посторонняя-семья-как-причина-пола", find: "  const fams = (ctx.logFamilies || []).filter((f) => asText(f?.id) && ids.includes(f.id));", put: "  const fams = (ctx.logFamilies || []).filter((f) => asText(f?.id));",
    guard: /смена одного оверлея объясняется со снимка и при журнале монитора/ },
  { id: "7-чужой-источник-приписан-карточке", find: "`${head}. На устаревших данных сейчас ${hit.length > 1 ? \"показатели\" : \"показатель\"} этой смены: ${hit.join(\", \")}`", put: "`${head} — на них опирается ${hit.join(\", \")}`",
    guard: /неполные данные названы в сообщении о доле источником/ },
  // --- выпуск 2.15.0: боевой набор v3 (фикс, ступени пола, два окна MVRV, смена правил) ---
  { id: "v3-смена-правил-как-рыночный-шаг", find: "  const sw = last.policy_switch || (!logged && live && steps.length === 1 && !resumed ? suiteSwitch(prevEng, eng) : null);", put: "  const sw = null;",
    guard: /шаг выпуска: цель изменили правила — названа смена правил, а не рынок/ },
  { id: "v3-смена-правил-только-по-журналу", find: "  const sw = last.policy_switch || (!logged && live && steps.length === 1 && !resumed ? suiteSwitch(prevEng, eng) : null);", put: "  const sw = last.policy_switch || null;",
    guard: /шаг выпуска без записи в журнале монитора/ },
  { id: "v3-пропущенный-выпуск-как-смена-правил", find: "(!logged && live && steps.length === 1 && !resumed ? suiteSwitch(prevEng, eng) : null);", put: "(live && steps.length === 1 && !resumed ? suiteSwitch(prevEng, eng) : null);",
    guard: /бот пропустил прогон выпуска/ },
  { id: "v3-причина-шага-выпуска-из-снимка", find: "  const oc = plainStep && !sw && (k.overlay || fs) && live ? overlayCause(last, eng, ctx) : null;\n  if (sw && plainStep) {", put: "  const oc = plainStep && (k.overlay || fs) && live ? overlayCause(last, eng, ctx) : null;\n  if (false) {",
    guard: /шаг выпуска: цель изменили правила — названа смена правил, а не рынок/ },
  { id: "v3-база-частот-на-шаге-выпуска", find: "  const past = dir !== 0 && !sw ? alikeHistory(", put: "  const past = dir !== 0 ? alikeHistory(",
    guard: /шаг выпуска без записи в журнале монитора/ },
  { id: "v3-база-частот-смешивает-наборы", find: "alikeHistory(sinceSuiteSwitch(feed.log && feed.log.length ? feed.log : prevState.alloc_changes), last)", put: "alikeHistory(feed.log && feed.log.length ? feed.log : prevState.alloc_changes, last)",
    guard: /после шага выпуска база частот считается только по сменам нынешнего набора правил/ },
  { id: "v3-правила-снимку-прежней-формы", find: "      suite === V3.suite &&\n      (!ids.allocation?.id || ids.allocation.id === V3.ids.allocation) &&", put: "      (!ids.allocation?.id || ids.allocation.id === V3.ids.allocation || ids.allocation.id === \"btc-allocation-policy-v1\") &&",
    guard: /снимок прежней формы читается без ошибок, и правил ему бот не приписывает/ },
  { id: "v3-правило-по-карточкам", find: "    blocks: suite === V3.suite ? { ...(live?.blocks || {}) } : Object.fromEntries(", put: "    blocks: false ? { ...(live?.blocks || {}) } : Object.fromEntries(",
    guard: /пороги и строка правила берутся из того, что читает движок, а не из карточек/ },
  { id: "v3-повышение-без-второго-фикса", find: "  const heldFull = v3 && !sw && (", put: "  const heldFull = false && (",
    guard: /повышение по режиму: было → стало, цена, режим/ },
  { id: "v3-срок-возврата-в-часах", find: "  const earliest = finite(nextFix) ? `, не раньше ${ruMoment(nextFix + DAY_MS)}` : \"\";", put: "  const earliest = `, не раньше ${ruMoment(eng.t + 48 * 3600e3)}`;",
    guard: /понижение по режиму: исполнять сразу, возврат — не раньше второго фикса подряд/ },
  { id: "v3-ожидание-без-счёта", find: "  const p = pendingOf(eng);\n  if (!p) return \"\";\n  const when", put: "  const p = null;\n  if (!p) return \"\";\n  const when",
    guard: /ожидающее повышение: счёт «1 из 2» и срок решения названы/ },
  { id: "v3-срыв-ожидания-между-фиксами", find: "  if (!eng.fix_at || eng.fix_at === prevEng.fix_at) return null; // между фиксами счёт не меняется\n", put: "",
    guard: /срыв ожидания: «кандидат не подтвердился на втором фиксе» — одно сообщение на эпизод/ },
  { id: "v3-сутки-без-фикса-не-срыв", find: "  if (same && finite(now.fixes) && finite(was.fixes) && now.fixes > was.fixes) return null;", put: "  if (same) return null;",
    guard: /срыв ожидания: новый кандидат и сутки без фикса/ },
  { id: "v3-о-срыве-больше-не-сообщается", find: "const HOLD_RESET_REPEAT_MS = 7 * 24 * 3600 * 1000;", put: "const HOLD_RESET_REPEAT_MS = 1000 * 24 * 3600 * 1000;",
    guard: /срыв ожидания: новый кандидат и сутки без фикса/ },
  { id: "v3-ступень-пола-не-названа", find: "  const fs = v3 ? floorStepOf(s) : null;\n  if (fs) return", put: "  const fs = null;\n  if (fs) return",
    guard: /пол восстановления растёт ступенями 40 → 60 → 80 по фиксам подряд/ },
  { id: "v3-ступень-пола-без-причины", find: "  if (fs) {\n    if (!fs.up) return", put: "  if (false) {\n    if (!fs.up) return",
    guard: /пол восстановления растёт ступенями 40 → 60 → 80 по фиксам подряд/ },
  { id: "v3-ступень-пола-причина-из-журнала", find: "  } else if (last.cause?.text && !fs) {", put: "  } else if (last.cause?.text) {",
    guard: /ступень пола: причина журнала монитора о давней смене режима к шагу не приписывается/ },
  { id: "v3-ступень-и-режим-без-причины-режима", find: "    if (regimeMoved && fs && last.cause?.text) {", put: "    if (false) {",
    guard: /ступень пола: причина журнала монитора о давней смене режима к шагу не приписывается/ },
  { id: "v3-пол-капитуляции-под-полом-восстановления", find: "  const cap = (eng.live?.cheap ?? eng.cheap) === true && finite(eng.base) && eng.base < V3.capitulationFloorPct;", put: "  const cap = false;",
    guard: /под полом восстановления лежит пол капитуляции/ },
  { id: "v3-пропущенный-фикс-без-причины", find: "    if (!fs.up) return { text: ctx.missedFix ? \"Причина: сутки прошли без фикса — счёт фиксов подряд начат заново\" : \"\", ids: [] };", put: "    if (!fs.up) return { text: \"\", ids: [] };",
    guard: /сутки без фикса: пол возвращается на первую ступень, и причина названа/ },
  { id: "v3-одно-окно-MVRV-в-тексте", find: "  return m.d === null ? fmtPlain(m.p) : `${fmtPlain(m.p)} за 4 года и ${fmtPlain(m.d)} по всей истории`;", put: "  return fmtPlain(m.p);",
    guard: /пол капитуляции: включается только при согласии двух окон MVRV, оба числа в тексте/ },
  { id: "v3-возврат-пола-капитуляции-без-окна", find: "  if (a && !b) return `${head} по всей истории тоже", put: "  if (false) return `${head} по всей истории тоже",
    guard: /пол капитуляции: включается только при согласии двух окон MVRV, оба числа в тексте/ },
  // --- п. 4: ошибки кода ---
  { id: "4-ключ-доли-без-времени", find: "    key: found.source === \"diff\" ? `alloc:${from}->${to}@base:${base}` : `alloc:${from}->${to}@${new Date(last.t).toISOString()}`,", put: "    key: `alloc:${from}->${to}`,",
    guard: /повтор той же смены доли в пределах недели не глушится/ },
  { id: "4-ключ-доли-по-времени-запуска", find: "    key: found.source === \"diff\" ? `alloc:${from}->${to}@base:${base}` : `alloc:${from}->${to}@${new Date(last.t).toISOString()}`,", put: "    key: `alloc:${from}->${to}@${Date.now()}`,",
    guard: /повторный прогон после сбоя смену доли не дублирует/ },
  { id: "4-ключ-детектора-без-времени", find: "      key: `risk:${d.id}:${to}@base:${base}`,", put: "      key: `risk:${d.id}:${to}`,",
    guard: /повторное срабатывание детектора в пределах недели не глушится/ },
  { id: "4-пауза-стирает-базу", find: "  const lastPct = hadTarget ? prevAlloc.pct : finite(prevState.last_alloc?.pct) ? prevState.last_alloc.pct : finite(legacyLast) ? legacyLast : null;", put: "  const lastPct = hadTarget ? prevAlloc.pct : null;",
    guard: /пауза решения не стирает базу/ },
  { id: "4-пауза-молчит", find: "      else out.push(pauseEvent(panel, base, prevAlloc.pct));", put: "",
    guard: /пауза решения не стирает базу/ },
  { id: "4-stale-рассылается", find: "    if (i.stale) continue;\n", put: "",
    guard: /карточка на отказавших входах не рассылается/ },
  { id: "4-stale-двигает-базу", find: "    if (i.stale && was && !was.stale && prev.version === 2) {", put: "    if (false) {",
    guard: /после отказа источника новое значение сравнивается с последним свежим/ },
  { id: "4-живой-фид-по-возрасту", find: "    const live = gap != null ? gap < DAILY_GAP_DAYS : finite(obs) ? generatedAt - obs < LIVE_FEED_MAX_AGE_MS : false;", put: "    const live = finite(obs) ? generatedAt - obs < LIVE_FEED_MAX_AGE_MS : false;",
    guard: /суточная карточка с датой «сегодня 00:00 UTC» — публикация/ },
  { id: "4-обновление-в-ту-же-дату-молчит", find: "(dateAdvanced || (sameDate && i.updates && !dict.drift))", put: "(dateAdvanced)",
    guard: /пересмотр свежего значения в ту же дату не молчит/ },
  { id: "4-было-из-прошлого-такта", find: "    const before = shown && hasValue(shown.v) ? shown.v : fmtValue(was);", put: "    const before = fmtValue(was);",
    guard: /«было» следующего сообщения равно «стало» предыдущего/ },
  { id: "4-шаги-между-запусками-теряются", find: "  if (!sameNum(lastPct, curAlloc.pct) || found.steps.length > 1) {", put: "  if (!sameNum(lastPct, curAlloc.pct)) {",
    guard: /смена, целиком уместившаяся между двумя запусками, оставляет след/ },
  { id: "4-приток-на-биржи-без-drift", find: 'rel: "Ончейн-данные сети биткоина", drift: true, s: { u: "BTC", auto: true } },', put: 'rel: "Ончейн-данные сети биткоина", s: { u: "BTC", auto: true } },',
    guard: /приток на биржи приходит раз в сутки — при сдвиге даты/ },
  { id: "4-drift-сравнение-с-прошлым-тактом", find: " || (dateAdvanced && unseen))) {", put: ")) {",
    guard: /приток на биржи приходит раз в сутки — при сдвиге даты/ },
  { id: "4-drift-вторая-строка-на-ту-же-дату", find: "    if (dict.drift && shown?.d && i.observed_at && i.observed_at <= shown.d) continue;", put: "",
    guard: /приток на биржи приходит раз в сутки — при сдвиге даты/ },
  { id: "4-drift-без-первого-значения", find: "  shownSeen = seedShown(shownSeen, panel, now, prev?.indicators);", put: "",
    guard: /приток на биржи приходит раз в сутки — при сдвиге даты/ },
  { id: "4-drift-смена-метода-как-скачок", find: "    if (i.scheduled && !dict.quiet && !methodMoved && (", put: "    if (i.scheduled && !dict.quiet && (",
    guard: /смена метода у суточной карточки — не скачок показателя/ },
  { id: "4-drift-смена-метода-без-новой-базы", find: "  shownSeen = seedShown(shownSeen, panel, now, prev?.indicators);", put: "  shownSeen = seedShown(shownSeen, panel, now);",
    guard: /смена метода у суточной карточки — не скачок показателя/ },
  // --- п. 5–10 ---
  { id: "5-порог-пересчёта-с-границей-масштаба", find: "    if ((Math.abs(newV - oldV) / top) * 100 < REVISION_MIN_PCT) { out.dust++; continue; }", put: "    if ((Math.abs(newV - oldV) / scale) * 100 < REVISION_MIN_PCT) { out.dust++; continue; }",
    guard: /порог пересчёта считается от величины точки и у ряда с малыми числами/ },
  { id: "5-пересчёт-сырым-числом", find: "        const s = HUMAN[i.id]?.s || null;", put: "        const s = null;",
    guard: /пересчёт истории печатается в единице ряда, а не сырым числом/ },
  { id: "5-имя-карточки-вместо-величины-ряда", find: "        const name = s?.n || humanTitle(i.id, i.name);", put: "        const name = humanTitle(i.id, i.name);",
    guard: /пересчёт истории печатается в единице ряда, а не сырым числом/ },
  { id: "5-стороны-пересчёта-в-разных-единицах", find: "  const top = Math.max(Math.abs(a), Math.abs(b));", put: "  const top = Math.min(Math.abs(a), Math.abs(b));",
    guard: /пересчёт истории печатается в единице ряда, а не сырым числом/ },
  { id: "5-единица-ряда-без-объявления", find: "const [before, after] = slot.s ? seriesPair(c.before, c.after, slot.s) : [fmtPoint(c.before), fmtPoint(c.after)];", put: "const [before, after] = seriesPair(c.before, c.after, slot.s || {});",
    guard: /без объявленной единицы ряда точка пересчёта печатается как раньше/ },
  { id: "5-карточка-без-единицы-молчит-в-логе", find: "  if (noUnit.length) console.log(", put: "  if (false) console.log(",
    guard: /без объявленной единицы ряда точка пересчёта печатается как раньше/ },
  { id: "5-склейка-строк-с-разными-единицами", find: "const sig = `${s ? `${s.u}|${s.per || 1}|${s.auto ? 1 : 0}` : \"\"}#${changed.map(", put: "const sig = `#${changed.map(",
    guard: /карточки с одинаковыми числами, но разными единицами в одну строку не склеиваются/ },
  { id: "5-порог-пересчёта-снят", find: "    if ((Math.abs(newV - oldV) / top) * 100 < REVISION_MIN_PCT) { out.dust++; continue; }", put: "",
    guard: /пересчёт истории меньше 0,1 % в рассылку не идёт/ },
  { id: "5-знак-процента-прежний", find: "pct: oldV === 0 ? null : ((newV - oldV) / Math.abs(oldV)) * 100 });", put: "pct: oldV === 0 ? null : (newV / oldV - 1) * 100 });",
    guard: /процент пересмотра у отрицательных величин имеет верный знак/ },
  { id: "5-смена-источника-как-пересмотр", find: "    if (sourceMoved || (wholesale && providerSwitch)) {", put: "    if (false) {",
    guard: /смена источника ряда не выдаётся за пересмотр/ },
  { id: "6-метка-по-чужой-величине", find: "const basisPoints = (i, hist) => (i.series_is_value === false ? ownHistoryPoints(hist, i) : i.points);", put: "const basisPoints = (i, hist) => i.points;",
    guard: /метка «сильнейшее движение» считается по той же величине/ },
  { id: "6-метка-знака-словесной-карточке", find: "    const numeric = isNumericLabel(i.value);", put: "    const numeric = true;",
    guard: /«смена на положительные значения» не ставится словесным карточкам/ },
  { id: "6-ноль-как-положительное", find: "    const toPlus = finite(wasNum) && wasNum < 0 && finite(i.value_num) && i.value_num > 0;", put: "    const toPlus = finite(wasNum) && wasNum < 0 && finite(i.value_num) && i.value_num >= 0;",
    guard: /ноль — не положительное значение/ },
  { id: "6-миллиарды-целыми", find: 'const v = sharpen(String(i.value ?? "").trim().replace(/(\\d)\\.(\\d)/g, "$1,$2"), i.value_num);', put: 'const v = String(i.value ?? "").trim().replace(/(\\d)\\.(\\d)/g, "$1,$2");',
    guard: /потоки ETF не округляются до целых миллиардов/ },
  { id: "6-двухлетка-без-уровня", find: '    if (dict.lvl && i.delta) marks.push(', put: '    if (false) marks.push(',
    guard: /2-летка подписана тем, что на ней напечатано/ },
  { id: "7-качество-выпадает", find: "  if (quality) causes.push(quality);", put: "",
    guard: /неполные данные названы в сообщении о доле источником/ },
  { id: "7-предупреждение-повторяется", find: "    if (!rec.announced && rec.runs >= WARN_CONFIRM_RUNS) {", put: "    if (rec.runs >= WARN_CONFIRM_RUNS) {",
    guard: /предупреждение, висящее неделями, не повторяется/ },
  { id: "7-предупреждение-с-первого-снимка", find: "const WARN_CONFIRM_RUNS = 2;", put: "const WARN_CONFIRM_RUNS = 1;",
    guard: /предупреждение, мигнувшее на один снимок, не объявляется/ },
  { id: "7-мигание-предупреждения-шлётся", find: "    if (now - Date.parse(gone) >= WARN_CLEAR_MS) cleared.push({ key, ...was });", put: "    if (true) cleared.push({ key, ...was });",
    guard: /предупреждение о данных: одно сообщение при появлении и одно при снятии/ },
  { id: "8-имя-детектора-утверждает-факт", find: '"Слом маржинального спроса": "Совместное ухудшение спроса: ETF, стейблкоины, биржи, спот США",', put: '"Слом маржинального спроса": "Приток денег в биткоин прекратился",',
    guard: /имя детектора называет условие, а не факт о рынке/ },
  // --- проверка смысла разбора (блок 5б, 29.10.2026) ---
  { id: "9-числа-разбора-не-сверяются", find: "  const stray = ev ? gStrayNumbers(sentence, ev) : [];", put: "  const stray = [];",
    guard: /разбор с посторонним числом отбрасывается/ },
  { id: "9-числа-из-всей-пачки", find: 'if ((isObj && "i" in e ? e.i : pos) === index) walk(', put: "if (true) walk(",
    guard: /сверка чисел смотрит на вход СВОЕГО события/ },
  { id: "9-нумерация-меток-не-проверяется", find: "  if (idx.some((i, k) => i !== k) || idx.length > n) return [null, ", put: "  if (false) return [null, ",
    guard: /сбой нумерации бракует ответ/ },
  { id: "9-проверка-не-подключена", find: "  const [parsed, summary] = guardReview(txt, input, events.length,",
    put: "  const parsed = gParseBlocks(txt, events.length)[0] || new Array(events.length).fill(null), summary = null;\n  if (false) guardReview(txt, input, events.length,",
    guard: /фраза с посторонним числом вырезается/ },
  { id: "9-тревога-доступа-не-ставится", find: "  if ([401, 402, 403].includes(status)) return true;", put: "  return false;",
    guard: /отказ 401\/402 и «кончились кредиты» — тревога в учёте/ },
  { id: "9-учёт-недели-не-шлётся-из-main", find: "  const sendOps = io.sendOps || (dry || io.deliver ? null : guardSendOps);", put: "  const sendOps = null;",
    guard: /main\(\): учёт переживает прогоны/ },
  { id: "9-вход-модели-без-решения", find: "  if (eng) {\n    // Решение — в терминах суточного фикса", put: "  if (false) {\n    // Решение — в терминах суточного фикса",
    guard: /во входе модели о смене доли есть причина, цена, режим, кандидат и оверлей/ },
  // С 28.10.2026 модель одна, и срок для сообщения о доле — это срок самого запроса (вместе с
  // повторами SDK), а не проверка между моделями цепочки.
  { id: "9-модель-ждут-без-срока", find: "  const timeoutMs = budgetMs > 0 ? Math.min(LLM_TIMEOUT_MS, budgetMs) : LLM_TIMEOUT_MS;", put: "  const timeoutMs = LLM_TIMEOUT_MS;",
    guard: /на сообщение о доле модель ждут не дольше отведённого/ },
  { id: "10-база-частот-по-всем-сменам", find: "  if (x.known && y.known && (x.overlay || y.overlay)) return sameSet(x.on, y.on) && sameSet(x.off, y.off);\n  return x.step === y.step;", put: "  return true;",
    guard: /меньше трёх таких же смен — база частот не печатается/ },
  { id: "9-история-макро-панели-в-единицах-подписи", find: 'const { scale, unit, cur } = i.series_is_value === undefined ? { scale: 1, unit: "" } : labelScale(i);', put: "const { scale, unit, cur } = labelScale(i);",
    guard: /панель, не объявляющая природу ряда, получает историю числами ряда/ },
  { id: "10-старт-наблюдения-в-базе-частот", find: ".filter((c) => finite(c?.t) && finite(c?.from) && finite(c?.to));", put: ".filter((c) => finite(c?.t) && finite(c?.to));",
    guard: /запись о старте наблюдения не идёт в базу частот/ },
  // --- настоящие формы полей монитора и сборщика ---
  { id: "формы-цепочка-журнала-без-начала", find: "    steps.length > 0 && sameNum(steps[0].from, from) && sameNum(steps[steps.length - 1].to, to) &&", put: "    steps.length > 0 && sameNum(steps[steps.length - 1].to, to) &&",
    guard: /запись журнала о старте наблюдения шагом цели не считается/ },
  { id: "формы-повтор-перехода-как-причина", find: "        cause: text && !BARE_CAUSE.test(text) ? {", put: "        cause: text ? {",
    guard: /причина журнала, повторяющая сам переход, причиной не считается/ },
  { id: "формы-мусор-в-уровнях-оценки", find: "  for (const l of asList(asObject(snap.valuation_levels)?.levels)) if (asObject(l) && asText(l.key))", put: "  for (const l of snap.valuation_levels?.levels || []) if (l?.key)",
    guard: /негодные значения необязательных полей не роняют рассылку/ },
  { id: "формы-мусор-в-записи-о-рождении", find: "      birth: birthOf(asObject(snap.regime_birth)?.strategic),", put: "      birth: snap.regime_birth?.strategic || null,",
    guard: /негодные значения необязательных полей не роняют рассылку/ },
  { id: "формы-мусор-в-предупреждениях", find: "      ? snap.data_warnings.filter((w) => asObject(w) && asText(w.source) && asText(w.code)).map((w) => ({", put: "      ? snap.data_warnings.map((w) => ({",
    guard: /негодные значения необязательных полей не роняют рассылку/ },
  { id: "формы-мусор-в-журнале", find: "      const e = asObject(raw) || {};", put: "      const e = raw;",
    guard: /негодные значения необязательных полей не роняют рассылку/ },
  { id: "формы-отказ-расчёта-как-снятие", find: "    warnings: Array.isArray(snap.data_warnings)\n", put: "    warnings: snap.data_warnings === null ? [] : Array.isArray(snap.data_warnings)\n",
    guard: /отказ расчёта предупреждений \(null вместо списка\) ничего не снимает/ },
  { id: "формы-скрытая-цель-как-смена-доли", find: "  const hasDecision = !gate;", put: "  const hasDecision = finite(dec.target_pct);",
    guard: /панель скрыла цель — это пауза, а не смена доли/ },
  // --- осторожный режим и первый запуск ---
  { id: "11-осторожный-режим-теряет-предупреждение", find: 'const SAFE_KINDS = new Set(["allocation", "pause", "hold", "risk", "quality"]);', put: 'const SAFE_KINDS = new Set(["allocation", "pause", "hold", "risk"]);',
    guard: /в осторожном режиме предупреждение о данных не теряется/ },
  { id: "11-откат-снимка-как-новые-данные", find: "  if (!first && finite(baseT) && finite(snapT) && snapT < baseT) {", put: "  if (false) {",
    guard: /снимок старше базы сравнения ничего не шлёт и базу не двигает/ },
  { id: "11-упавшие-тесты-глушат-долю", find: "    queue = queue.filter((ev) => SAFE_KINDS.has(ev.kind));", put: "    queue = [];",
    guard: /упавшие тесты не выключают сообщения о доле/ },
  { id: "первый-запуск-повтор-разосланного", find: "    queue = events.filter((ev) => !toldByLegacyBot(ev, sentIndex, panel));", put: "    queue = events;",
    guard: /первый запуск на состоянии прежнего формата: разосланное прежней версией не повторяется/ },
  { id: "первый-запуск-данные-придержаны-целиком", find: "    queue = events.filter((ev) => !toldByLegacyBot(ev, sentIndex, panel));", put: "    queue = events.filter((ev) => SAFE_KINDS.has(ev.kind));",
    guard: /первый запуск на состоянии прежнего формата: разосланное прежней версией не повторяется, новое приходит/ },
  { id: "первый-запуск-сверка-без-значения", find: "  if (!tails.length) return false;\n  const byId", put: "  return tails.length > 0;\n  const byId",
    guard: /первый запуск на состоянии прежнего формата: другое значение за ту же дату — новость/ },
  { id: "первый-запуск-сверка-без-прежней-подписи", find: '[m.after, byId.has(m.id) ? legacyLabel(byId.get(m.id)) : ""]', put: "[m.after]",
    guard: /первый запуск на состоянии прежнего формата: разосланное прежней версией не повторяется/ },
  { id: "первый-запуск-пауза-теряется", find: "finite(prevState.last_alloc?.pct) ? prevState.last_alloc.pct : finite(legacyLast) ? legacyLast : null;", put: "finite(prevState.last_alloc?.pct) ? prevState.last_alloc.pct : null;",
    guard: /выкладка, попавшая на паузу решения, не теряет сообщение о возобновлении/ },
  // --- единый стиль сообщений (стандарт 29.10.2026) ---
  { id: "стиль-без-пометки-панели", find: "const headLine = (emoji, title) => `${emoji} <b>${esc(PANEL_TAG)} · ${esc(title)}</b>`;", put: "const headLine = (emoji, title) => `${emoji} <b>${esc(title)}</b>`;",
    guard: /каждый вид сообщения: пометка «Bitcoin»/ },
  { id: "стиль-время-UTC", find: "const MSK_MS = 3 * 3600e3;", put: "const MSK_MS = 0;",
    guard: /время — по Москве с пометкой/ },
  { id: "стиль-год-всегда", find: 'd.getUTCFullYear() === refYear() ? "" :', put: 'false ? "" :',
    guard: /время — по Москве с пометкой/ },
  { id: "стиль-дефис-вместо-минуса", find: '  return (zero ? "" : x < 0 ? MINUS : sign ? "+" : "") + body;', put: '  return (zero ? "" : x < 0 ? "-" : sign ? "+" : "") + body;',
    guard: /единый стиль: каждое разосланное сообщение/ },
  { id: "стиль-доллар-после-числа", find: "`${x < 0 ? MINUS : \"\"}$${fmtNum(Math.abs(Math.round(x)), { digits: 0 })}`", put: "`${fmtNum(Math.round(x), { digits: 0 })} $`",
    guard: /единый стиль: каждое разосланное сообщение/ },
  { id: "стиль-подписи-сборщика-как-есть", find: "  return typo(i.unit && !v.includes(i.unit) ? `${v} ${i.unit}` : v);", put: "  return i.unit && !v.includes(i.unit) ? `${v} ${i.unit}` : v;",
    guard: /единый стиль: каждое разосланное сообщение/ },
  { id: "стиль-шаблон-как-разбор", find: "  else if (note) lines.push(\"\", `<i>${esc(note)}</i>`);", put: "  else if (note) lines.push(\"\", \"💬 \" + esc(note));",
    guard: /разбор модели о смене доли: честный идёт в сообщение/ },
  { id: "стиль-без-подвала", find: "  return `${clipTelegram(lines.join(\"\\n\"), TG_TEXT_LIMIT - tail.length - 2)}\\n\\n${tail}`;", put: "  return clipTelegram(lines.join(\"\\n\"));",
    guard: /единый стиль: каждое разосланное сообщение/ },
  { id: "стиль-промпт-без-шага-дальше", find: "· На что смотреть дальше. Только условно: «если …, то …» — с конкретным признаком из входа, который подтвердит или опровергнет картину.", put: "· Что будет дальше: прогноз цены.",
    guard: /промпт: что значит → почему важно → на что смотреть/ },
  { id: "стиль-было-прежней-версии-как-есть", find: '[id, asObject(r) && typeof r.v === "string" ? { ...r, v: typo(r.v) } : r]', put: "[id, r]",
    guard: /«было», запомненное прежней версией бота, читается в записи стандарта/ },
  { id: "первый-запуск-старые-записи-журнала", find: "  const inWindow = (s) => (!finite(prevT) || s.t > prevT) && s.t <= curT + 1000;", put: "  const inWindow = (s) => s.t <= curT + 1000;",
    guard: /первый запуск после выкладки/ },
];

const only = process.argv[2] || "";
const dir = mkdtempSync(join(tmpdir(), "notify-mutation-"));
// Тесты комментатора идут через настоящий SDK Anthropic (сеть подменена), а копия живёт во
// временном каталоге, где node_modules нет. Зависимости рабочей копии подключаются ссылкой — на
// Windows это junction, ему не нужны права администратора. Ссылка снимается ДО удаления каталога:
// рекурсивное удаление не должно даже пытаться пройти по ней в настоящий node_modules.
const deps = join(here, "..", "node_modules");
const depsLink = join(dir, "node_modules");
if (existsSync(deps)) symlinkSync(deps, depsLink, "junction");
let survived = 0, broken = 0, ran = 0;
try {
  writeFileSync(join(dir, "notify-test.mjs"), tests);
  // общие векторы проверки разбора (блок 5б) читаются тестами рядом с собой
  writeFileSync(join(dir, "llm-guard-vectors.json"), readFileSync(join(here, "llm-guard-vectors.json")));
  // сначала — что немутированная копия зелёная: иначе «красный» ничего не доказывает
  writeFileSync(join(dir, "notify.mjs"), source);
  const clean = spawnSync(process.execPath, [join(dir, "notify-test.mjs")], { encoding: "utf8" });
  if (clean.status !== 0) {
    console.error("тесты красные ещё до мутаций — сначала почините их:\n" + (clean.stderr || "").slice(0, 2000));
    process.exit(1);
  }
  for (const m of MUTATIONS) {
    if (only && !m.id.includes(only)) continue;
    ran++;
    const hits = source.split(m.find).length - 1;
    if (hits !== 1) {
      broken++;
      console.log(`СЛОМАНА   ${m.id}: фрагмент встречается в notify.mjs ${hits} раз — мутация отстала от кода`);
      continue;
    }
    writeFileSync(join(dir, "notify.mjs"), source.replace(m.find, () => m.put));
    const r = spawnSync(process.execPath, [join(dir, "notify-test.mjs")], { encoding: "utf8" });
    const failed = [...(r.stderr || "").matchAll(/^ПРОВАЛ: (.+)$/gm)].map((x) => x[1]);
    const guarded = failed.some((name) => m.guard.test(name));
    if (r.status !== 0 && guarded) console.log(`убита     ${m.id}: упало тестов ${failed.length}`);
    else {
      survived++;
      console.log(`ВЫЖИЛА    ${m.id}: ${r.status === 0 ? "тесты зелёные" : `упали не те тесты (${failed.slice(0, 3).join("; ") || "без имён"})`}`);
    }
  }
} finally {
  try { unlinkSync(depsLink); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
console.log(`мутаций: ${ran}, убито ${ran - survived - broken}, выжило ${survived}, сломано ${broken}`);
process.exit(survived || broken ? 1 : 0);
