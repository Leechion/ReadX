import { useEffect, useMemo, useRef, useState } from 'react';
import { STORAGE_KEYS, readJSON, readString, writeJSON, writeString } from '../../lib/storage';
import { Game2048 } from './Game2048';

export type GameCategory = 'puzzle' | 'arcade' | 'strategy' | 'coop';

export interface GameEntry {
  id: string;
  title: string;
  subtitle: string;
  description: string;
  category: GameCategory;
  tags: string[];
  players: string;
  controls: string[];
  hint: string;
  /** Built-in React games omit dir; iframe games point to public/games/<dir>. */
  dir?: string;
  background: string;
  isNew?: boolean;
  isCoop?: boolean;
}

const RECENT_GAMES_KEY = `${STORAGE_KEYS.slackGame}-recent`;

export const GAME_CATALOG: GameEntry[] = [
  {
    id: 'kitchen-rush',
    title: '手忙脚乱',
    subtitle: '同屏厨房切菜下锅，配合赶订单',
    description: '两人一个跑一个递，取食材、切配、上炉、装盘、送单窗一气呵成。第 5 单起出现双料订单，锅待太久会烧糊冒烟把人熏倒，搭档必须及时救起。2P 不按键时机器人自动补位。',
    category: 'coop',
    tags: ['双人同屏', '合作厨房'],
    players: '1–2 人同屏',
    controls: ['1P：WASD 移动 · E 拿/放/救人', '2P：方向键移动 · L 拿/放（按一下接管）', 'P 暂停 · M 静音'],
    hint: '1P WASD + E 拿/放，2P 方向键 + L（或机器人补位），P 暂停',
    dir: 'kitchen-rush',
    background: '#6a4a30',
    isNew: true,
    isCoop: true,
  },
  {
    id: 'score-clash',
    title: '双人抢分对决',
    subtitle: '夜市抢碎片存罐子，冲撞撒满地',
    description: '碎片在夜市场地不断刷新，身上最多带 3 份，带得越多跑得越慢，带回自家陶罐才算数。按冲撞把对手撞晕，他身上的碎片立刻撒一地！30 秒一局、三局两胜，2P 不按键时由机器人补位。',
    category: 'coop',
    tags: ['双人同屏', '派对对抗'],
    players: '1–2 人同屏',
    controls: ['1P：WASD 移动 · E 冲撞', '2P：方向键移动 · L 冲撞（按一下接管）', 'P 暂停 · M 静音'],
    hint: '1P WASD + E 冲撞，2P 方向键 + L（或机器人补位），P 暂停',
    dir: 'score-clash',
    background: '#120e24',
    isNew: true,
    isCoop: true,
  },
  {
    id: 'split-the-work',
    title: '双人分工解谜',
    subtitle: '一个推木箱、一个钻窄缝，交替开门',
    description: '石头地窑五间房一间接一间：1P 暖橙力气大推得动木箱，2P 青蓝身形小钻得过石缝。铜板踩住铁闸才升起，轮流替对方守门或用木箱压板，两人各站目标格即过关。',
    category: 'coop',
    tags: ['双人同屏', '分工解谜'],
    players: '1–2 人同屏',
    controls: ['1P：WASD 移动（撞木箱即推）', '2P：方向键移动（钻窄缝，按一下接管）', 'R 重来本间 · P 暂停 · M 静音'],
    hint: '1P WASD 推箱，2P 方向键钻窄缝（或机器人补位），R 重来本关',
    dir: 'split-the-work',
    background: '#15151a',
    isNew: true,
    isCoop: true,
  },
  {
    id: 'brick-smash',
    title: '碎砖',
    subtitle: '反弹角随击中板位变化，越碎球越快',
    description: '经典夜色街机打砖块：六行三层耐久砖墙，板边救球角度更斜，每碎 8 块球速自动提档，不断落板连碎还有连击倍数加成。3 条命挑战能清掉多少面墙！',
    category: 'arcade',
    tags: ['街机经典', '弹珠打砖'],
    players: '单人',
    controls: ['鼠标 / ←→ / AD 移板', '空格 / 点击发射弹珠', 'P 暂停 · M 静音'],
    hint: '鼠标 / ←→ 移板，空格 / 点击发射，P 暂停',
    dir: 'brick-smash',
    background: '#141830',
    isNew: true,
  },
  {
    id: 'bullet-rain',
    title: '弹雨',
    subtitle: '深夜海空纵版弹幕，擦边走位斩巨舰',
    description: '自动双联装开火，判定点比机身更小，专治贴弹缝走位的手痒。蜂群直冲、炮舰瞄准弹、环织三向扇层层压上，坚持 60 秒迎战巨舰弹环，善用清屏炸弹绝处逢生。',
    category: 'arcade',
    tags: ['纵版射击', '弹幕躲避'],
    players: '单人',
    controls: ['方向键 / WASD 走位（自动开火）', '空格 / X 放炸弹清屏', 'P 暂停 · M 静音'],
    hint: '方向键 / WASD 走位（自动开火），空格 / X 放炸弹，P 暂停',
    dir: 'bullet-rain',
    background: '#10162c',
    isNew: true,
  },
  {
    id: '2048',
    title: '2048',
    subtitle: '经典 4×4 数字滑动合并，支持撤销一步',
    description: '摸鱼常青树：方向键、WASD 或触控滑动移动棋盘，相同数字撞在一起翻倍合成。内置步步进度本地保存与单步撤销，随时偷闲推两把。',
    category: 'puzzle',
    tags: ['数字益智', '随时暂停'],
    players: '单人',
    controls: ['方向键 / WASD / 触屏滑动', '界面按钮支持单步撤销与重开'],
    hint: '方向键 / WASD / 滑动',
    background: 'transparent',
  },
  {
    id: 'full-row',
    title: '满行',
    subtitle: '干脆利落的落块消行，硬降影线手感佳',
    description: '经典俄罗斯方块玩法，带落点虚影预览、下一个方块提示与软降/硬降控制。拼满整行瞬间消掉并累计倍率，越消节奏越紧凑。',
    category: 'puzzle',
    tags: ['经典方块', '消行解压'],
    players: '单人',
    controls: ['←→ 移动 · ↑ 旋转', '↓ 软降 · 空格硬降', 'P 暂停 · M 静音'],
    hint: '方向键移动旋转，空格硬降，P 暂停',
    dir: 'full-row',
    background: '#0d1321',
  },
  {
    id: 'gulp-cells',
    title: '吞吞',
    subtitle: '吃掉比自己小的细胞，躲开庞然大物',
    description: '在深海微粒世界里从一颗小细胞起步，鼠标引导游动方向，吞噬比自己小的细胞不断膨胀分裂，同时小心别撞上大块头。',
    category: 'arcade',
    tags: ['吞噬成长', '鼠标操控'],
    players: '单人',
    controls: ['鼠标指针引导移动方向', 'R 快速重开 · M 静音'],
    hint: '鼠标引导方向，吃小的、躲大的，R 重开',
    dir: 'gulp-cells',
    background: '#0a1e33',
  },
  {
    id: 'quiet-mines',
    title: '安静扫雷',
    subtitle: '暖纸风格无压扫雷，支持标旗与撤销',
    description: '仿暖色纸张的护眼扫雷桌面版，提供三种棋盘难度切换、右键标旗防误触以及 U 键撤销一步，摸鱼时安安静静排完雷区。',
    category: 'puzzle',
    tags: ['纸张护眼', '逻辑推理'],
    players: '单人',
    controls: ['左键翻开 · 右键标旗', 'U 撤销 · 1 / 2 / 3 切换难度'],
    hint: '左键翻开，右键标旗，U 撤销，1/2/3 换难度',
    dir: 'quiet-mines',
    background: '#efe6cf',
  },
  {
    id: 'endless-dash',
    title: '狂奔',
    subtitle: '黄昏沙丘跑酷，长按高跳与低头滑铲',
    description: '一根手指就能玩的生死时速：按住跳得更高、松手瞬间截断成短跳，搭配土狼时间与空中速降滑铲，穿过一道道矮石与悬岩。',
    category: 'arcade',
    tags: ['无尽跑酷', '单手爽游'],
    players: '单人',
    controls: ['空格 / ↑ / W 跳跃（长按高跳）', '↓ / S 滑铲（空中按加速落地）', 'P 暂停 · M 静音'],
    hint: '空格 / ↑ 跳跃（长按高跳），↓ 滑铲，P 暂停',
    dir: 'endless-dash',
    background: '#2a1712',
  },
  {
    id: 'idle-empire',
    title: '点点帝国',
    subtitle: '敲铜钱雇帮手，凑齐 25 个产量翻倍',
    description: '轻松放置小品：点大铜钱进账，花钱雇佣帮手行自动生钱，每档帮手满 25 个即可解锁产量翻倍，还有转生印章越滚越大。',
    category: 'strategy',
    tags: ['轻松放置', '数值养成'],
    players: '单人',
    controls: ['鼠标点击铜钱进账', '点击右侧帮手行雇佣与升级'],
    hint: '点铜钱进账，点帮手行雇佣，满 25 个翻倍',
    dir: 'idle-empire',
    background: '#ecd9a8',
  },
  {
    id: 'one-man-guard',
    title: '一夫当关',
    subtitle: '手绘古风塔防，落塔升级守住防线',
    description: '在羊皮卷战场上布置各色炮台与弓弩塔，合理利用射程交叉口拦截一波波敌兵，随时升级或卖出换位，提前呼出下一波赚取额外赏金。',
    category: 'strategy',
    tags: ['策略塔防', '波次拦截'],
    players: '单人',
    controls: ['左下角选塔落位战场', 'U 升级选中塔 · S 卖出 · 空格提前下一波'],
    hint: '左下选塔落位，U 升级，S 卖出，空格提前下一波',
    dir: 'one-man-guard',
    background: '#e8dcc0',
  },
  {
    id: 'one-more-push',
    title: '推一把',
    subtitle: '八道精选推箱机关，步步可撤销重来',
    description: '暖木仓库里的 8 关精品推箱谜题：小心别把箱子推进死角，走错了随时按 U 退回一步，或按 1–8 直接挑选任意关卡挑战最佳步数。',
    category: 'puzzle',
    tags: ['推箱烧脑', '8 关精选'],
    players: '单人',
    controls: ['方向键 / WASD 推箱移动', 'U 撤销 · R 重开本关 · 1–8 选关'],
    hint: '方向键 / WASD 推箱，U 撤销，R 重开，1-8 选关',
    dir: 'one-more-push',
    background: '#3a2418',
  },
  {
    id: 'play-your-cards',
    title: '出牌吧!',
    subtitle: '爬塔构筑卡组，砍牌强化过关斩将',
    description: '微型肉鸽卡牌爬塔：算好费用与敌人下回合意图，点选或拖拽出牌格挡反击；每战结束三选一强化卡组，还能在篝火/营地砍掉多余废牌。',
    category: 'strategy',
    tags: ['卡牌肉鸽', '构筑策略'],
    players: '单人',
    controls: ['鼠标点选或拖拽出牌', '1 / 2 / 3 选战后奖励 · X 砍牌'],
    hint: '点选或拖拽出牌，1/2/3 选奖励，X 砍牌',
    dir: 'play-your-cards',
    background: '#14100c',
  },
  {
    id: 'tide-reap',
    title: '潮汐割草',
    subtitle: '深海提灯幸存者，自动索敌武器进化',
    description: '只需要走位的 3 分钟海底幸存者割草：飞刀、潮环、光鳗自动朝海怪输出，升级三选一还能触发武器进化，撑到最后斩杀潮王！',
    category: 'arcade',
    tags: ['肉鸽割草', '自动索敌'],
    players: '单人',
    controls: ['方向键 / WASD 海底走位', '1 / 2 / 3 或点选升级卡 · P 暂停'],
    hint: '方向键 / WASD 走位（自动开火），1/2/3 选升级，P 暂停',
    dir: 'tide-reap',
    background: '#0c1626',
  },
];

export type GameId = GameEntry['id'];

export const GAME_TABS: Array<{ id: GameId; title: string; hint: string }> = GAME_CATALOG.map(
  ({ id, title, hint }) => ({ id, title, hint })
);

const CATEGORY_LABELS: Array<{ id: 'all' | GameCategory; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'coop', label: '双人同屏' },
  { id: 'puzzle', label: '益智解谜' },
  { id: 'arcade', label: '动作街机' },
  { id: 'strategy', label: '策略放置' },
];

function iconUrl(id: string): string {
  return new URL(`game-icons/${id}.jpg`, document.baseURI).href;
}

function matchesCategory(game: GameEntry, category: 'all' | GameCategory): boolean {
  if (category === 'all') return true;
  if (category === 'puzzle' && game.id === 'split-the-work') return true;
  return game.category === category;
}

/**
 * 游戏脚本是独立页面：全局变量、window 级键盘监听与 requestAnimationFrame 循环都不能和应用混在一起，
 * 因此放进 srcdoc iframe 里运行，卸载 iframe 即彻底停止游戏。
 * srcdoc 不是网络响应，不受 X-Frame-Options 影响；脚本仍是同源外链文件，满足 script-src 'self'。
 */
function buildSrcDoc(game: GameEntry): string {
  const resolve = (file: string) => new URL(`games/${game.dir}/${file}`, document.baseURI).href;
  const cursorStyle = game.id === 'gulp-cells' ? 'cursor: crosshair;' : '';
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${game.title}</title>
<style>
  html, body { margin: 0; height: 100%; background: ${game.background}; overflow: hidden; }
  body { font-variant-numeric: tabular-nums; }
  canvas { display: block; margin: 0 auto; ${cursorStyle} }
</style></head>
<body><canvas id="game"></canvas>
<script src="${resolve('config.js')}"></script>
<script src="${resolve('game.js')}"></script>
</body></html>`;
}

function GameFrame({ game, reloadKey, onEscape }: { game: GameEntry; reloadKey: number; onEscape: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const escape = useRef(onEscape);
  escape.current = onEscape;

  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    const attach = () => {
      const contentWindow = element.contentWindow;
      if (!contentWindow) return;
      // iframe 里的按键不会冒泡到应用窗口：Esc 与 Boss 键（Ctrl+Shift+M）需要转发。
      contentWindow.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          escape.current();
        } else if (event.ctrlKey && event.shiftKey && (event.key === 'M' || event.key === 'm')) {
          window.dispatchEvent(
            new KeyboardEvent('keydown', {
              key: event.key,
              code: event.code,
              ctrlKey: true,
              shiftKey: true,
              bubbles: true,
            })
          );
        }
      });
      contentWindow.focus();
      // 触发 resize 事件以确保 canvas 按照最终窗口比例完成初次适应
      contentWindow.dispatchEvent(new Event('resize'));
      setTimeout(() => {
        try {
          contentWindow.dispatchEvent(new Event('resize'));
        } catch {
          /* ignore */
        }
      }, 50);
    };
    element.addEventListener('load', attach);
    return () => element.removeEventListener('load', attach);
  }, [game, reloadKey]);

  return (
    <iframe
      key={`${game.id}-${reloadKey}`}
      ref={frame}
      className="slack-game-frame"
      style={{ background: game.background }}
      title={game.title}
      srcDoc={buildSrcDoc(game)}
      allow="autoplay"
    />
  );
}

export function GameHub({ onEscape }: { onEscape: () => void }) {
  const [playingId, setPlayingId] = useState<GameId | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [category, setCategory] = useState<'all' | GameCategory>('all');
  const [query, setQuery] = useState('');
  const [detailGame, setDetailGame] = useState<GameEntry | null>(null);
  const [featuredIndex, setFeaturedIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>(() => {
    const saved = readJSON<string[]>(RECENT_GAMES_KEY, []);
    if (Array.isArray(saved) && saved.length) {
      return saved.filter((id) => GAME_CATALOG.some((g) => g.id === id));
    }
    const last = readString(STORAGE_KEYS.slackGame, '');
    return GAME_CATALOG.some((g) => g.id === last) ? [last] : [];
  });

  const activeGame = useMemo(
    () => (playingId ? GAME_CATALOG.find((g) => g.id === playingId) ?? null : null),
    [playingId]
  );

  // 分层 Esc：详情弹窗 -> 关闭弹窗；游玩中 -> 返回商店；商店主页 -> 交由 SlackWorkspace 返回书架。
  useEffect(() => {
    if (!detailGame && !activeGame) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (detailGame) {
        setDetailGame(null);
      } else if (activeGame) {
        setPlayingId(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [detailGame, activeGame]);

  const launchGame = (id: GameId) => {
    setDetailGame(null);
    setPlayingId(id);
    setReloadKey((k) => k + 1);
    writeString(STORAGE_KEYS.slackGame, id);
    setRecentIds((prev) => {
      const next = [id, ...prev.filter((item) => item !== id)].slice(0, 5);
      writeJSON(RECENT_GAMES_KEY, next);
      return next;
    });
  };

  const newReleases = useMemo(() => GAME_CATALOG.filter((g) => g.isNew), []);
  const spotlight = newReleases[featuredIndex % newReleases.length] ?? GAME_CATALOG[0];

  const recentGames = useMemo(
    () => recentIds.map((id) => GAME_CATALOG.find((g) => g.id === id)).filter((g): g is GameEntry => Boolean(g)),
    [recentIds]
  );

  const filteredGames = useMemo(() => {
    const q = query.trim().toLowerCase();
    return GAME_CATALOG.filter((game) => {
      if (!matchesCategory(game, category)) return false;
      if (!q) return true;
      return (
        game.title.toLowerCase().includes(q) ||
        game.subtitle.toLowerCase().includes(q) ||
        game.description.toLowerCase().includes(q) ||
        game.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [category, query]);

  if (activeGame) {
    return (
      <div className="slack-gamehub">
        <div className="slack-gamehub__bar">
          <div className="slack-gamehub__playing">
            <button
              type="button"
              className="slack-topbar__back"
              onClick={() => setPlayingId(null)}
            >
              ← 游戏商店
            </button>
            <img
              className="slack-store__icon slack-store__icon--xs"
              src={iconUrl(activeGame.id)}
              alt=""
            />
            <strong>{activeGame.title}</strong>
            <span className="slack-store__pill">{activeGame.players}</span>
          </div>
          <div className="slack-gamehub__meta">
            <small>{activeGame.hint}</small>
            {activeGame.dir ? (
              <button
                type="button"
                className="slack-topbar__back"
                onClick={() => setReloadKey((k) => k + 1)}
                title="重新载入当前游戏"
              >
                ↻ 重载
              </button>
            ) : null}
          </div>
        </div>
        {activeGame.dir ? (
          <GameFrame
            game={activeGame}
            reloadKey={reloadKey}
            onEscape={() => setPlayingId(null)}
          />
        ) : (
          <Game2048 />
        )}
      </div>
    );
  }

  return (
    <div className="slack-store">
      <div className="slack-store__inner">
        <header className="slack-store__header">
          <div>
            <h1>摸鱼游戏商店</h1>
          </div>
          <div className="slack-store__controls">
            <div className="slack-filters" role="tablist" aria-label="游戏分类">
              {CATEGORY_LABELS.map((item) => {
                const count = GAME_CATALOG.filter((g) => matchesCategory(g, item.id)).length;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={category === item.id}
                    className={category === item.id ? 'active' : ''}
                    onClick={() => setCategory(item.id)}
                  >
                    {item.label} ({count})
                  </button>
                );
              })}
            </div>
            <label className="slack-search">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索游戏、玩法或标签…"
                aria-label="搜索小游戏"
              />
            </label>
          </div>
        </header>

        {recentGames.length > 0 && !query.trim() && category === 'all' ? (
          <section className="slack-store__recent" aria-label="最近常玩">
            <span className="slack-store__label">最近在玩</span>
            <div className="slack-store__recent-list">
              {recentGames.map((game) => (
                <button
                  key={game.id}
                  type="button"
                  className="slack-store__recent-chip"
                  onClick={() => launchGame(game.id)}
                >
                  <img
                    className="slack-store__icon slack-store__icon--sm"
                    src={iconUrl(game.id)}
                    alt=""
                  />
                  <span>{game.title}</span>
                  <small>继续</small>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        {spotlight && !query.trim() && category === 'all' ? (
          <section className="slack-store__hero" aria-label="新品推荐">
            <div className="slack-store__hero-main">
              <img
                className="slack-store__icon slack-store__icon--xl"
                src={iconUrl(spotlight.id)}
                alt={`${spotlight.title} 图标`}
              />
              <div className="slack-store__hero-info">
                <div className="slack-store__hero-badges">
                  <span className="slack-store__badge slack-store__badge--accent">新品上架</span>
                  <span className="slack-store__pill">{spotlight.players}</span>
                  {spotlight.tags.map((tag) => (
                    <span key={tag} className="slack-store__pill">{tag}</span>
                  ))}
                </div>
                <h2>{spotlight.title}</h2>
                <p>{spotlight.description}</p>
                <div className="slack-store__hero-actions">
                  <button
                    type="button"
                    className="slack-primary"
                    onClick={() => launchGame(spotlight.id)}
                  >
                    立即开玩
                  </button>
                  <button
                    type="button"
                    className="slack-store__secondary"
                    onClick={() => setDetailGame(spotlight)}
                  >
                    查看玩法说明
                  </button>
                </div>
              </div>
            </div>
            <div className="slack-store__hero-switcher" aria-label="切换推荐新品">
              {newReleases.map((item, idx) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === spotlight.id ? 'active' : ''}
                  onClick={() => setFeaturedIndex(idx)}
                  title={item.title}
                >
                  <img
                    className="slack-store__icon slack-store__icon--sm"
                    src={iconUrl(item.id)}
                    alt=""
                  />
                  <span>{item.title}</span>
                </button>
              ))}
            </div>
          </section>
        ) : null}

        <section aria-label="全部游戏列表">
          <div className="slack-store__section-head">
            <h3>
              {query.trim()
                ? `搜索结果 (${filteredGames.length})`
                : category === 'all'
                  ? '全部游戏'
                  : `${CATEGORY_LABELS.find((c) => c.id === category)?.label ?? ''} (${filteredGames.length})`}
            </h3>
          </div>

          {filteredGames.length === 0 ? (
            <div className="slack-empty slack-empty--small">
              <div>
                <h2>没有找到匹配的小游戏</h2>
                <p>试试清空搜索词或切换到「全部」分类。</p>
                <button
                  type="button"
                  className="slack-primary"
                  onClick={() => {
                    setQuery('');
                    setCategory('all');
                  }}
                >
                  显示全部游戏
                </button>
              </div>
            </div>
          ) : (
            <div className="slack-store__grid">
              {filteredGames.map((game) => (
                <article
                  key={game.id}
                  className="slack-store__card"
                  onClick={() => setDetailGame(game)}
                >
                  <img
                    className="slack-store__icon slack-store__icon--lg"
                    src={iconUrl(game.id)}
                    alt={`${game.title} 图标`}
                    loading="lazy"
                  />
                  <div className="slack-store__card-body">
                    <div className="slack-store__card-title">
                      <strong>{game.title}</strong>
                      {game.isNew ? <span className="slack-store__badge">NEW</span> : null}
                    </div>
                    <p>{game.subtitle}</p>
                    <div className="slack-store__card-tags">
                      <span className="slack-store__pill">{game.players}</span>
                      {game.tags.slice(0, 1).map((tag) => (
                        <span key={tag} className="slack-store__pill">{tag}</span>
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="slack-store__get"
                    onClick={(event) => {
                      event.stopPropagation();
                      launchGame(game.id);
                    }}
                  >
                    打开
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>

        <footer className="slack-store__footer">
          <button type="button" className="slack-topbar__back" onClick={onEscape}>
            ← 返回书架
          </button>
        </footer>
      </div>

      {detailGame ? (
        <div
          className="slack-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="slack-game-detail-title"
          onClick={() => setDetailGame(null)}
        >
          <div
            className="slack-modal__card slack-store__detail"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="slack-store__detail-head">
              <img
                className="slack-store__icon slack-store__icon--xl"
                src={iconUrl(detailGame.id)}
                alt={`${detailGame.title} 图标`}
              />
              <div className="slack-store__detail-meta">
                <div className="slack-store__hero-badges">
                  {detailGame.isNew ? (
                    <span className="slack-store__badge slack-store__badge--accent">NEW</span>
                  ) : null}
                  <span className="slack-store__pill">{detailGame.players}</span>
                  {detailGame.tags.map((tag) => (
                    <span key={tag} className="slack-store__pill">{tag}</span>
                  ))}
                </div>
                <h2 id="slack-game-detail-title">{detailGame.title}</h2>
                <p>{detailGame.subtitle}</p>
              </div>
            </div>

            <div className="slack-store__detail-section">
              <h3>玩法介绍</h3>
              <p>{detailGame.description}</p>
            </div>

            <div className="slack-store__detail-section">
              <h3>操作说明</h3>
              <ul>
                {detailGame.controls.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>

            <div className="slack-modal__actions">
              <button type="button" onClick={() => setDetailGame(null)}>关闭</button>
              <button
                type="button"
                className="slack-primary"
                onClick={() => launchGame(detailGame.id)}
              >
                立即开始
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
