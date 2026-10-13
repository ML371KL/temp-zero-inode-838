// Сдвиг часов для прогона наборов тестов «в другой день недели и в другой час».
//
// Наборы с календарными фикстурами (торговые дни ETF, закрытие суток UTC, экспирации) обязаны быть
// зелёными в любой день и час, а не только в день написания. Этот модуль подключается до теста и
// сдвигает Date на заданное число часов; часы при этом продолжают идти. Через NODE_OPTIONS сдвиг
// наследуют и дочерние процессы, которыми тесты запускают сборщик.
//
// Один прогон (bash):
//   SHIFT_CLOCK_HOURS=37 NODE_OPTIONS="--import=$(node -p 'require("url").pathToFileURL("scripts/collector-shift-clock.mjs").href')" node scripts/fallback-test.mjs
// Обход недели (семь суток × четыре часа суток, наборы потока «сборщик»):
//   node scripts/collector-shift-clock.mjs --sweep
// Сдвиг только вперёд: закоммиченный снимок при этом «стареет», что наборы обязаны переносить, а
// сдвиг назад сделал бы его снимком из будущего.
import { spawnSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";

const shiftHours=Number(process.env.SHIFT_CLOCK_HOURS);
if(Number.isFinite(shiftHours)&&shiftHours!==0&&!globalThis.__collectorClockShifted){
  const RealDate=Date,offset=Math.round(shiftHours*3_600_000);
  class ShiftedDate extends RealDate{
    constructor(...args){if(!args.length)super(RealDate.now()+offset);else super(...args);}
    static now(){return RealDate.now()+offset;}
  }
  globalThis.Date=ShiftedDate;
  globalThis.__collectorClockShifted=true;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href&&process.argv.includes("--sweep")){
  const self=pathToFileURL(fileURLToPath(import.meta.url)).href,HOUR=3_600_000,DAY=24*HOUR;
  const suites=["unit-test.mjs","fixture-test.mjs","fallback-test.mjs","live-regression-test.mjs"];
  // Часы суток UTC, на которых календарные фикстуры ломались раньше: сразу после полуночи, за полчаса
  // до канонического полудня потоков ETF, сразу после него и перед полуночью.
  const hours=[0.2,11.5,12.5,23.6],now=Date.now(),midnight=Math.floor(now/DAY)*DAY;
  let failed=0;
  for(let day=1;day<=7;day++)for(const hour of hours){
    const target=midnight+day*DAY+hour*HOUR,shift=(target-now)/HOUR,label=new Date(target).toISOString().slice(0,16)+" "+["вс","пн","вт","ср","чт","пт","сб"][new Date(target).getUTCDay()];
    const bad=[];
    for(const suite of suites){
      const r=spawnSync(process.execPath,[fileURLToPath(new URL(`./${suite}`,import.meta.url))],{encoding:"utf8",env:{...process.env,SHIFT_CLOCK_HOURS:String(shift),NODE_OPTIONS:`${process.env.NODE_OPTIONS||""} --import=${self}`.trim()}});
      if(r.status!==0)bad.push(`${suite}: ${((r.stderr||"")+(r.stdout||"")).split("\n").filter(l=>/Error|failed|^- /.test(l)).slice(0,2).join(" | ").slice(0,300)}`);
    }
    failed+=bad.length;
    console.log(`${bad.length?"FAIL":"ok  "} ${label}${bad.length?"\n     "+bad.join("\n     "):""}`);
  }
  console.log(failed?`обход недели: отказов ${failed}`:`обход недели: ${7*hours.length} моментов × ${suites.length} набора — всё зелёное`);
  process.exit(failed?1:0);
}
