import { useEffect, useRef, useState } from 'react';
import type { DocumentSummary } from '@cbct/shared';
import { isSectionFormat } from '@cbct/shared';
import type { DocumentMeta } from '../api/client';
import { api } from '../api/client';
import './paper-line-art.css';

export type Subject = 'imaging' | 'biology' | 'medicine' | 'ai' | 'physics' | 'materials' | 'environment' | 'math' | 'general';

// The library already stores first-page text for many PDFs. Load it only for
// visible covers; titles and user tags still work before text is available.
const pageTextCache = new Map<string, string>();
const subjects: { name: Subject; cues: RegExp[] }[] = [
  { name: 'imaging', cues: [/\b(?:cbct|ct|mri|pet|tomography|tomographic|sinogram|radiograph|x-ray|xray)\b/i, /医学影像|断层|成像|重建|锥束|放射影像/] },
  { name: 'biology', cues: [/\b(?:gene|genome|genomic|dna|rna|protein|molecular|cellular|cells?|biolog\w*|omics|single-cell)\b/i, /基因|蛋白|细胞|生物学|生物科学|分子生物|基因组/] },
  { name: 'medicine', cues: [/\b(?:clinical|patient|cancer|tumou?r|disease|diagnos\w*|cardiac|surgical|treatment|medical)\b/i, /临床|患者|肿瘤|癌症|疾病|诊断|手术|治疗|医学/] },
  { name: 'ai', cues: [/\b(?:ai|machine learning|deep learning|neural|transformer|diffusion models?|large language models?|computer vision|artificial intelligence|segmentation|detection)\b/i, /机器学习|深度学习|神经网络|人工智能|大语言模型|图像分割|目标检测/] },
  { name: 'environment', cues: [/\b(?:climate|environment\w*|ecolog\w*|carbon|biodiversity|ocean|atmospher\w*|sustainab\w*|remote sensing)\b/i, /气候|环境|生态|碳排放|海洋|可持续|遥感/] },
  { name: 'materials', cues: [/\b(?:material\w*|crystal\w*|polymer\w*|nanoparticle\w*|alloy\w*|cataly\w*|battery|batteries|electrode\w*)\b/i, /材料|晶体|聚合物|纳米颗粒|合金|催化|电池|电极/] },
  { name: 'physics', cues: [/\b(?:quantum|particle\w*|photon\w*|optical|physics|physical|wave\w*|laser\w*|astronom\w*)\b/i, /量子|粒子|光子|光学|物理|激光|天文/] },
  { name: 'math', cues: [/\b(?:mathemat\w*|theorem\w*|optimization|optimisation|statistic\w*|probability|algorithm\w*|graph theory)\b/i, /数学|定理|优化|统计|概率|算法|图论/] },
];

function chooseSubjects(doc: DocumentSummary, meta: DocumentMeta | undefined, text: string): [Subject, Subject | null] {
  const title = `${doc.title || ''} ${doc.translatedTitle || ''}`;
  const tags = [...(meta?.tags || []), ...(meta?.categories || [])].join(' ');
  const ranked = subjects.map(subject => ({
    name: subject.name,
    score: subject.cues.reduce((sum, cue) => sum + (cue.test(title) ? 8 : 0) + (cue.test(tags) ? 5 : 0) + (cue.test(text) ? 1 : 0), 0),
  })).filter(subject => subject.score > 0).sort((a, b) => b.score - a.score);
  return [ranked[0]?.name || 'general', ranked[1] && ranked[1].score >= 5 ? ranked[1].name : null];
}

/** Prefer a shelf's own name; fall back to the subjects of its document titles. */
export function chooseShelfSubject(name: string, documents: DocumentSummary[]): Subject {
  const byName = subjects.map(subject => ({
    name: subject.name,
    score: subject.cues.reduce((sum, cue) => sum + (cue.test(name) ? 1 : 0), 0),
  })).sort((a, b) => b.score - a.score);
  if (byName[0]?.score) return byName[0].name;
  const scores = new Map<Subject, number>();
  for (const doc of documents) {
    const subject = chooseSubjects(doc, undefined, '')[0];
    if (subject !== 'general') scores.set(subject, (scores.get(subject) || 0) + 1);
  }
  return subjects.reduce((best, subject) => (scores.get(subject.name) || 0) > (scores.get(best) || 0) ? subject.name : best, 'general' as Subject);
}

export function seedFor(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

// Each paper keeps the same composition across reloads, without sharing a
// random-number generator with other covers.
function detail(seed: number, index: number) {
  let value = seed ^ Math.imul(index + 1, 0x9e3779b9);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  value ^= value >>> 16;
  return (value >>> 0) / 0x100000000;
}

function PaperDetails({ seed }: { seed: number }) {
  const x = 15 + Math.round(detail(seed, 1) * 22);
  const y = 30 + Math.round(detail(seed, 2) * 42);
  const width = 18 + Math.round(detail(seed, 3) * 28);
  const mode = Math.floor(detail(seed, 4) * 5);
  const dots = Array.from({ length: 7 }, (_, i) => ({
    x: x + Math.round(detail(seed, 10 + i) * width),
    y: y + Math.round(detail(seed, 20 + i) * 65),
    r: 0.8 + detail(seed, 30 + i) * 1.6,
  }));
  return <g opacity=".78">
    {mode === 0 && <>
      <path d={`M${x} ${y + 55} Q${x + width / 2} ${y - 22} ${x + width + 17} ${y + 25}`} />
      <path d={`M${x - 5} ${y + 64} Q${x + width / 2} ${y - 10} ${x + width + 22} ${y + 34}`} />
    </>}
    {mode === 1 && <>
      <path d={`M${x} ${y}v${width + 30}h${width + 8}M${x + 7} ${y + 9}v${width + 16}h${width - 2}`} />
      <path d={`M${x + 8} ${y + 22}h${width - 5}M${x + 8} ${y + 30}h${Math.round(width * .62)}`} strokeDasharray="2 4" />
    </>}
    {mode === 2 && <>
      <ellipse cx={x + width / 2} cy={y + 35} rx={width / 2 + 9} ry={25 + detail(seed, 5) * 15} />
      <ellipse cx={x + width / 2} cy={y + 35} rx={width / 2 + 3} ry={17 + detail(seed, 6) * 13} />
    </>}
    {mode === 3 && <>
      <path d={`M${x} ${y + 64} ${x + width * .3} ${y + 22} ${x + width * .7} ${y + 48} ${x + width} ${y}`} />
      <path d={`M${x - 5} ${y + 72}h${width + 10}M${x - 5} ${y + 72}v-55`} strokeDasharray="2 4" />
    </>}
    {mode === 4 && <>
      <path d={`M${x} ${y}h${width}M${x} ${y + 9}h${Math.round(width * .7)}M${x} ${y + 18}h${Math.round(width * .85)}`} />
      <path d={`M${x} ${y + 54}q${Math.round(width / 2)} -${Math.round(width / 2)} ${width} 0`} />
    </>}
    {dots.map((dot, i) => <circle key={i} cx={dot.x} cy={dot.y} r={dot.r} fill="currentColor" stroke="none" />)}
  </g>;
}

function AlternateDrawing({ subject, variant }: { subject: Subject; variant: number }) {
  if (subject === 'imaging') return variant === 1 ? <>
    <circle cx="104" cy="85" r="59" /><circle cx="104" cy="85" r="38" />
    <path d="M58 135h89l14 23H45l13-23ZM74 123v12m61-12v12M74 98h92v13H74zM126 75h25M151 65v20" />
    <path d="M25 41h26M25 48h16M156 35l13-10M162 43l16-6" strokeDasharray="3 5" />
  </> : <>
    <ellipse cx="98" cy="105" rx="27" ry="37" /><ellipse cx="98" cy="105" rx="17" ry="25" />
    <path d="M98 14 49 157M98 14l66 143M98 14 98 105M30 157h145M51 145 98 105l66 40" />
    <circle cx="98" cy="14" r="5" /><path d="M22 79a78 78 0 0 1 143-30M160 40l5 9-11 1M44 167h117" strokeDasharray="4 4" />
  </>;
  if (subject === 'biology') return variant === 1 ? <>
    <circle cx="99" cy="96" r="58" /><circle cx="99" cy="96" r="48" strokeDasharray="3 5" /><circle cx="99" cy="96" r="19" />
    <ellipse cx="70" cy="75" rx="11" ry="6" transform="rotate(-28 70 75)" /><ellipse cx="130" cy="118" rx="12" ry="6" transform="rotate(22 130 118)" />
    <path d="M72 113c8-12 17-9 17 1s-10 18-17 10M121 67c9-7 16 0 13 9s-13 11-18 4M35 57l13 5M149 137l15 7" />
  </> : <>
    <path d="M40 118 57 83 90 62 120 76 144 46 166 73 151 111 117 128 86 115 58 140Z" />
    <path d="M57 83l29 32 4-53 27 66 3-52 31 35M40 118l46-3M120 76l46-3" />
    {[[40,118],[57,83],[90,62],[120,76],[144,46],[166,73],[151,111],[117,128],[86,115],[58,140]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 5 : 3} fill="var(--paper-art-bg)" />)}
  </>;
  if (subject === 'medicine') return variant === 1 ? <>
    <circle cx="104" cy="86" r="53" /><path d="M66 88h24l7-16 12 32 8-16h25M104 33v-11M104 150v-11M51 86H40M168 86h-11" />
    <path d="M58 149h92M72 142v7m64-7v7M82 29h44M89 21h30" />
  </> : <>
    <path d="M100 40v103M70 63c-20 9-22 43-8 61 8 10 20 13 29 6V74c-4-8-12-12-21-11Zm60 0c20 9 22 43 8 61-8 10-20 13-29 6V74c4-8 12-12 21-11Z" />
    <path d="M100 46 88 35m12 11 12-11M55 150h90M45 34h13M51.5 27.5v13M144 39h14M151 32v14" />
  </>;
  if (subject === 'ai') return variant === 1 ? <>
    <rect x="20" y="70" width="35" height="44" rx="4" /><rect x="82" y="48" width="40" height="88" rx="4" /><rect x="148" y="70" width="32" height="44" rx="4" />
    <path d="M55 82h27M55 102h27M122 82h26M122 102h26M28 80h19M28 90h19M28 100h12M90 59h24M90 70h24M90 81h24M90 92h24M90 103h24M90 114h24M155 85h18M155 95h18" />
    <circle cx="68" cy="82" r="3" fill="var(--paper-art-bg)" /><circle cx="135" cy="102" r="3" fill="var(--paper-art-bg)" />
  </> : <>
    <path d="M35 51 68 31 101 51 134 31 167 51v38l-33 19-33-19-33 19-33-19V51ZM68 31v38m33-18v38m33-58v38M35 51l33 18 33-18 33 18 33-18M68 69v39m66-39v39" />
    <path d="M52 133h96M67 143h66M82 153h36M53 121h93" strokeDasharray="3 4" />
  </>;
  if (subject === 'environment') return variant === 1 ? <>
    <path d="M96 157c-5-39 11-79 53-110-4 47-22 75-53 83m0 27c-6-27-22-42-47-51 5 26 22 43 47 44M96 130l31-38M96 148l-26-25" />
    <circle cx="100" cy="98" r="72" strokeDasharray="3 6" /><path d="M36 37h15M43.5 29.5v15M151 145h12M157 139v12" />
  </> : <>
    <circle cx="100" cy="95" r="61" /><path d="M39 104q18-20 34 0t33 0 33 0 22 0M44 120q15-14 29 0t33 0 33 0 16 0M53 86l26-29 21 24 15-18 31 31" />
    <circle cx="137" cy="62" r="8" /><path d="M30 159h140M55 168h90" strokeDasharray="3 5" />
  </>;
  if (subject === 'materials') return variant === 1 ? <>
    <path d="M100 26 151 51 100 77 49 51l51-25ZM49 70l51 26 51-26M49 89l51 26 51-26M49 108l51 26 51-26M49 127l51 26 51-26" />
    <path d="M49 51v76m102-76v76M100 77v76" strokeDasharray="3 5" /><circle cx="100" cy="77" r="4" fill="var(--paper-art-bg)" />
  </> : <>
    <path d="M45 49h109v88H45zM57 62h85v62H57zM82 62v62m31-62v62M57 83h85M57 103h85" />
    {[[57,62],[82,62],[113,62],[142,62],[57,83],[82,83],[113,83],[142,83],[57,103],[82,103],[113,103],[142,103],[57,124],[82,124],[113,124],[142,124]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r="3.5" fill="var(--paper-art-bg)" />)}
  </>;
  if (subject === 'physics') return variant === 1 ? <>
    <path d="M24 95h152M30 95c12-38 24-38 36 0s24 38 36 0 24-38 36 0 24 38 36 0" />
    <path d="M30 95c12 24 24 24 36 0s24-24 36 0 24 24 36 0 24-24 36 0" strokeDasharray="4 4" />
    <circle cx="100" cy="95" r="63" /><path d="M100 22v12M100 156v12" />
  </> : <>
    <circle cx="101" cy="96" r="62" /><path d="M42 80 79 62l34 26 40-40M79 62l15 64 41 16M113 88l-19 38M113 88l37 28M42 80l25 62 27-16" />
    {[[42,80],[79,62],[113,88],[153,48],[94,126],[135,142],[150,116],[67,142]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r={i % 2 ? 4 : 6} fill="var(--paper-art-bg)" />)}
  </>;
  if (subject === 'math') return variant === 1 ? <>
    <circle cx="100" cy="94" r="62" /><ellipse cx="100" cy="94" rx="62" ry="24" transform="rotate(35 100 94)" /><ellipse cx="100" cy="94" rx="62" ry="24" transform="rotate(-35 100 94)" />
    <path d="M38 94h124M100 32v124M56 50l88 88M144 50l-88 88" strokeDasharray="3 5" />
    <circle cx="100" cy="94" r="5" fill="var(--paper-art-bg)" />
  </> : <>
    <path d="M35 142V49h130v93H35ZM35 111l37-34 29 22 31-42 33 21M35 129l37-20 29 13 31-28 33 11" />
    <circle cx="72" cy="77" r="4" fill="var(--paper-art-bg)" /><circle cx="101" cy="99" r="4" fill="var(--paper-art-bg)" /><circle cx="132" cy="57" r="4" fill="var(--paper-art-bg)" />
    <path d="M46 153h109M57 38h86" strokeDasharray="3 5" />
  </>;
  return variant === 1 ? <>
    <circle cx="100" cy="95" r="58" /><circle cx="100" cy="95" r="39" /><circle cx="100" cy="95" r="20" />
    <path d="M100 19v19M100 152v19M24 95h19M157 95h19M51 46l13 13M136 131l13 13" />
  </> : <>
    <path d="M36 121 64 66 100 40l39 24 27 55-30 32H65l-29-30ZM64 66l36 31 39-33M36 121l64-24 66 22M65 151l35-54 36 54M100 40v57" />
    <circle cx="100" cy="97" r="5" fill="var(--paper-art-bg)" />
  </>;
}

export function SubjectDrawing({ subject, variant }: { subject: Subject; variant: number }) {
  if (variant > 0) return <AlternateDrawing subject={subject} variant={variant} />;
  switch (subject) {
    case 'imaging': return <>
      <circle cx="100" cy="94" r="57" /><circle cx="100" cy="94" r="43" /><ellipse cx="100" cy="94" rx="27" ry="36" />
      <path d="M78 79c8-9 15-9 22-2 8-7 16-7 22 2 7 11 4 28-4 37-7 8-12 3-18 3s-11 5-18-3c-8-9-11-26-4-37Z" />
      <path d="M100 62v64M70 94h60M100 20v10M100 158v10M26 94h10M164 94h10" strokeDasharray="3 5" />
      <path d="M38 48 21 36M162 48l17-12M38 140l-17 12M162 140l17 12" />
    </>;
    case 'biology': return <>
      <path d="M67 19c0 37 66 39 66 76s-66 39-66 76M133 19c0 37-66 39-66 76s66 39 66 76" />
      <path d="M69 28h62M75 43h50M88 57h24M90 72h20M76 87h48M68 100h64M75 115h50M89 130h22M87 145h26M74 160h52" />
      <circle cx="46" cy="49" r="10" /><circle cx="155" cy="132" r="13" /><circle cx="155" cy="132" r="4" /><path d="M43 75v17M35 83h16M151 45h14M158 38v14" />
    </>;
    case 'medicine': return <>
      <path d="M100 146C80 129 53 112 53 86c0-24 31-32 47-10 16-22 47-14 47 10 0 26-27 43-47 60Z" />
      <path d="M32 98h37l9-17 12 35 13-28 8 10h57" /><circle cx="100" cy="98" r="70" strokeDasharray="2 7" />
      <path d="M100 16v12M100 168v12M18 98h12M170 98h12" />
    </>;
    case 'ai': return <>
      <path d="M28 45 70 32 104 57 147 35 174 75 155 122 116 153 67 145 31 119 28 45ZM28 45l40 49 36-37 8 44 35-66M68 94l-37 25m37-25-1 51m1-51 44 7 4 52m-4-52 43 21m-43-21 62-26" />
      {[[28,45],[70,32],[104,57],[147,35],[174,75],[155,122],[116,153],[67,145],[31,119],[68,94],[112,101]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r={i > 8 ? 5 : 3.5} fill="var(--paper-art-bg)" />)}
      <path d="M53 20h24M123 168h24" />
    </>;
    case 'physics': return <>
      <circle cx="100" cy="96" r="7" /><ellipse cx="100" cy="96" rx="69" ry="25" /><ellipse cx="100" cy="96" rx="69" ry="25" transform="rotate(60 100 96)" /><ellipse cx="100" cy="96" rx="69" ry="25" transform="rotate(-60 100 96)" />
      <circle cx="162" cy="85" r="4" fill="var(--paper-art-bg)" /><circle cx="70" cy="42" r="4" fill="var(--paper-art-bg)" /><circle cx="64" cy="145" r="4" fill="var(--paper-art-bg)" />
      <path d="M19 24h13M25.5 17.5v13M165 161h13M171.5 154.5v13" />
    </>;
    case 'materials': return <>
      <path d="M100 22 150 50v57l-50 29-50-29V50l50-28ZM50 50l50 29 50-29M100 79v57M28 121l45 26 27-11M150 107l22 13-49 28-23-12" />
      <path d="M100 22v57M50 107l50-28 50 28M73 147v24m50-23v23" strokeDasharray="3 5" />
      {[[100,22],[150,50],[150,107],[100,136],[50,107],[50,50],[100,79]].map(([x,y], i) => <circle key={i} cx={x} cy={y} r="4" fill="var(--paper-art-bg)" />)}
    </>;
    case 'environment': return <>
      <circle cx="100" cy="92" r="60" /><ellipse cx="100" cy="92" rx="29" ry="60" /><path d="M40 92h120M49 62h102M49 122h102" />
      <path d="M82 160c1-29 13-43 34-56-3 22-14 36-34 37m0 19c-4-20-15-28-30-32 4 16 14 25 30 27" />
      <path d="M146 25h14M153 18v14M30 157h12M36 151v12" />
    </>;
    case 'math': return <>
      <path d="M28 144h145M42 159V25M42 133c19-6 29-53 50-49 19 4 21 37 40 24 12-8 19-36 36-55" />
      <path d="M50 115 80 115 80 84 111 84 111 108 140 108 140 67 169 67" strokeDasharray="3 5" />
      <circle cx="80" cy="84" r="4" fill="var(--paper-art-bg)" /><circle cx="111" cy="108" r="4" fill="var(--paper-art-bg)" /><circle cx="140" cy="67" r="4" fill="var(--paper-art-bg)" />
      <path d="M139 24h24M151 12v24M58 27h20M58 34h20" />
    </>;
    default: return <>
      <path d="M36 140V51l48-19 48 19v89l-48-18-48 18ZM84 32v90M132 51l26-10v88l-26 11" />
      <path d="M48 62l24-9M48 73l24-9M48 84l24-9M96 53l24 9M96 64l24 9M96 75l24 9" />
      <circle cx="148" cy="47" r="25" /><path d="m166 65 15 15M36 156h96" />
    </>;
  }
}

export function PaperLineArt({ doc, meta }: { doc: DocumentSummary; meta: DocumentMeta | undefined }) {
  const host = useRef<HTMLSpanElement>(null);
  const cacheKey = `${doc.key}:${doc.updatedAt}`;
  const [text, setText] = useState(() => pageTextCache.get(cacheKey) || '');

  useEffect(() => {
    setText(pageTextCache.get(cacheKey) || '');
    if (isSectionFormat(doc.format) || !host.current || pageTextCache.has(cacheKey)) return;
    const controller = new AbortController();
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some(entry => entry.isIntersecting)) return;
      observer.disconnect();
      void api.page(doc.key, 1, controller.signal).then(page => {
        const excerpt = page.text.slice(0, 6000);
        pageTextCache.set(cacheKey, excerpt);
        if (!controller.signal.aborted) setText(excerpt);
      }).catch(() => { /* No indexed first page yet: use title and tags. */ });
    }, { rootMargin: '200px' });
    observer.observe(host.current);
    return () => { observer.disconnect(); controller.abort(); };
  }, [cacheKey, doc.key, doc.format]);

  const [subject, secondary] = chooseSubjects(doc, meta, text);
  const seed = seedFor(doc.key || doc.title);
  const angle = Math.round(detail(seed, 40) * 22) - 11;
  const scale = .8 + detail(seed, 41) * .2;
  const mirrored = detail(seed, 42) > .5;
  const variant = Math.floor(detail(seed, 50) * 3);
  const shiftX = Math.round(detail(seed, 43) * 16) - 8;
  const shiftY = Math.round(detail(seed, 44) * 14) - 7;
  return <span ref={host} className={`paper-line-art paper-line-art--${subject}`} aria-hidden="true">
    <svg viewBox="0 0 200 190" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <PaperDetails seed={seed} />
      <g transform={`translate(${100 + shiftX} ${95 + shiftY}) rotate(${angle}) scale(${mirrored ? -scale : scale} ${scale}) translate(-100 -95)`}>
        <SubjectDrawing subject={subject} variant={variant} />
      </g>
      {secondary && <g transform={`translate(${4 + Math.round(detail(seed, 51) * 10)} ${100 + Math.round(detail(seed, 52) * 15)}) scale(.32)`} opacity=".85">
        <SubjectDrawing subject={secondary} variant={Math.floor(detail(seed, 53) * 3)} />
      </g>}
      <path d={`M${147 + Math.round(detail(seed, 45) * 12)} 12h${15 + Math.round(detail(seed, 46) * 20)}M${159 + Math.round(detail(seed, 47) * 10)} 18h12`} opacity=".7" />
    </svg>
  </span>;
}
