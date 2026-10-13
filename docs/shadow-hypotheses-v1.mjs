/*
 * Теневой слой: заранее объявленные проверяемые утверждения (аудит 2026-10-10).
 *
 * Восемь карточек без голоса копят значения, но до сих пор ни одна не была обязана что-либо
 * предсказать: значения нигде не записывались, критерия не было. Здесь для каждой карточки ДО
 * наблюдения объявлено одно утверждение — условие на значение, горизонт и ожидаемый знак разницы
 * форвардной доходности BTC между днями «условие выполнено» и «не выполнено». Форвард-монитор
 * записывает значения в дневные строки и ведёт счёт (`monitoring.shadow_evidence`).
 *
 * Правила: утверждение следует из экономического смысла карточки и НЕ подбиралось по истории;
 * пороги — естественные (ноль, единица, себестоимость) либо те, что уже стоят в описании карточки;
 * счёт идёт только по дням не раньше `declared_at`; автоматических выводов нет — карточка не
 * получает голос и не теряет его по этому счёту, решение остаётся за владельцем и процедурой
 * POLICY.md. Карточка без осмысленного направленного утверждения так и объявлена: statement null.
 * Объявление заморожено: изменить утверждение — значит выпустить v2 этого файла и начать счёт заново.
 */

const deepFreeze=value=>{
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))deepFreeze(child);
  }
  return value;
};

export const SHADOW_HYPOTHESES_V1=deepFreeze({
  id:"btc-shadow-hypotheses-v1",
  version:1,
  declared_at:"2026-10-10",
  outcome:"доходность BTC от закрытия дня наблюдения до закрытия дня через horizon_days суток",
  // expected_sign: +1 — в дни «условие выполнено» форвардная доходность ожидается ВЫШЕ, −1 — ниже.
  cards:{
    tga_daily:{
      statement:"Когда казначейский счёт США за 28 дней снизился, BTC за следующие 30 дней растёт сильнее, чем после его роста.",
      condition:{kind:"change",lookback_days:28,op:"<",value:0},horizon_days:30,expected_sign:1,
      rationale:"Снижение счёта возвращает резервы в банковскую систему — та же механика, что в голосующей ноге чистой ликвидности, но без недельного запаздывания.",
    },
    g3_liquidity:{
      statement:"Когда суммарный баланс ФРС, ЕЦБ и Банка Японии в долларах за 28 дней вырос, BTC за следующие 30 дней растёт сильнее, чем после его сжатия.",
      condition:{kind:"change",lookback_days:28,op:">",value:0},horizon_days:30,expected_sign:1,
      rationale:"Голосующая нога видит только баланс ФРС; если мировая ликвидность информативна сверх американской, знак обязан проявиться здесь.",
    },
    gold_axis:{
      statement:null,condition:null,horizon_days:null,expected_sign:null,
      rationale:"Корреляция с золотом описывает, как торгуется BTC — как защитный актив или как риск, — но не куда он пойдёт. Направленного утверждения о доходности у карточки нет; значения записываются.",
    },
    sth_pricing:{
      statement:"Когда цена выше себестоимости краткосрочных держателей (STH-MVRV не ниже 1), BTC за следующие 30 дней растёт сильнее, чем когда она ниже.",
      condition:{kind:"level",op:">=",value:1},horizon_days:30,expected_sign:1,
      rationale:"Себестоимость недавних покупателей — водораздел: выше неё откаты выкупаются, ниже она становится сопротивлением.",
    },
    realized_pnl:{
      statement:"Когда монеты в среднем продаются в убыток (SOPR за 7 дней ниже 1), BTC за следующие 30 дней слабее, чем при продажах в прибыль.",
      condition:{kind:"level",op:"<",value:1},horizon_days:30,expected_sign:-1,
      rationale:"Устойчивый SOPR ниже единицы — капитуляция в процессе: продавцы фиксируют убыток, давление предложения не исчерпано.",
    },
    options_structure:{
      statement:"Когда ближняя подразумеваемая волатильность дороже дальней (бэквордация), BTC за следующие 7 дней слабее, чем при контанго.",
      condition:{kind:"level",op:">",value:0},horizon_days:7,expected_sign:-1,
      rationale:"Бэквордация — стресс здесь и сейчас. Карточка заслуживает голоса как признак хрупкости, только если после неё действительно хуже.",
    },
    oi_purge_24h:{
      statement:"После суточного сброса открытого интереса на 10 % и больше BTC за следующие 7 дней растёт сильнее, чем в остальные дни.",
      condition:{kind:"level",op:"<=",value:-10},horizon_days:7,expected_sign:1,
      rationale:"Резкий сброс открытого интереса означает, что каскад ликвидаций состоялся и плечо вымыто — вынужденных продавцов стало меньше.",
    },
    hash_ribbons:{
      statement:"В первые 30 дней после восстановительного креста хешрейта (SMA30/SMA60 вернулось к 1 и выше) BTC за следующие 30 дней растёт сильнее, чем в остальные дни.",
      condition:{kind:"cross_up",level:1,within_days:30},horizon_days:30,expected_sign:1,
      rationale:"Канонический сигнал конца капитуляции майнеров. Окна 30 и 60 — из литературы, не подбирались; сигнал запаздывающий и общеизвестный.",
    },
  },
});

export const SHADOW_CARD_IDS_V1=Object.freeze(Object.keys(SHADOW_HYPOTHESES_V1.cards));

const DAY=86_400_000;
const finite=x=>x!==null&&x!==""&&Number.isFinite(Number(x));
const dayNumber=date=>Math.round(Date.parse(`${date}T00:00:00.000Z`)/DAY);
const compare=(x,op,y)=>op==="<"?x<y:op==="<="?x<=y:op===">"?x>y:op===">="?x>=y:null;

// Выполнено ли условие карточки в день series[index]. series — [{date:"YYYY-MM-DD",value}] по
// возрастанию дат. Возвращает true, false либо null, когда оценить нельзя: значения нет или
// истории не хватает на окно условия. Неоценённые дни в счёт не входят ни в одну из групп.
export function shadowConditionStateV1(condition,series,index){
  const row=series?.[index];
  if(!condition||!row||!finite(row.value))return null;
  const value=Number(row.value),day=dayNumber(row.date);
  if(condition.kind==="level")return compare(value,condition.op,condition.value);
  if(condition.kind==="change"){
    // Опорная точка — значение lookback_days назад; при пропуске дня годится точка до трёх суток старше.
    let base=null;
    for(let i=index-1;i>=0;i--){
      const age=day-dayNumber(series[i].date);
      if(age>condition.lookback_days+3)break;
      if(age>=condition.lookback_days&&finite(series[i].value)){base=Number(series[i].value);break;}
    }
    return base===null?null:compare(value-base,condition.op,condition.value);
  }
  if(condition.kind==="cross_up"){
    if(value<condition.level)return false;
    let oldest=0;
    for(let i=index-1;i>=0;i--){
      const age=day-dayNumber(series[i].date);
      if(age>condition.within_days)break;
      if(!finite(series[i].value))continue;
      if(Number(series[i].value)<condition.level)return true;
      oldest=age;
    }
    // Креста в окне не видно. «Не было» можно утверждать, только если окно наблюдено почти целиком.
    return oldest>=condition.within_days*0.8?false:null;
  }
  return null;
}
