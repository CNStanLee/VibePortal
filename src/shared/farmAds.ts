/*
 * Ads on the crab farm: a banner, and short ads you can watch for tokens (a few a
 * day). The ads are VibePortal's own ("house ads") until an ad network is set up.
 */

export interface HouseAd {
  id: string;
  icon: string;
  zh: { title: string; body: string; cta: string };
  en: { title: string; body: string; cta: string };
  /** where its button goes (an app page, or a web page in a new tab) */
  href: string;
}

export const HOUSE_ADS: HouseAd[] = [
  {
    id: 'star',
    icon: '⭐',
    zh: { title: '喜欢 VibePortal？', body: '去 GitHub 点个 Star，让更多人看到这只螃蟹。', cta: '去点 Star' },
    en: { title: 'Enjoying VibePortal?', body: 'Star it on GitHub so more people meet the crab.', cta: 'Star on GitHub' },
    href: 'https://github.com/CNStanLee/VibePortal',
  },
  {
    id: 'office',
    icon: '🏢',
    zh: { title: '让 Claude 和 Codex 组队干活', body: '在办公室里写下目标，自动拆成团队、分配模型，交付物层层验收。', cta: '去办公室' },
    en: { title: 'Put Claude and Codex on one team', body: 'Write a goal in the office: it becomes a team with models, handoffs and acceptance criteria.', cta: 'Open the office' },
    href: '#/office',
  },
  {
    id: 'friends',
    icon: '🦀',
    zh: { title: '朋友来浇水，作物长得快', body: '公开你的农场，把链接发给朋友，互相浇水、比比收藏。', cta: '分享农场' },
    en: { title: 'Friends make crops grow faster', body: 'Make your farm public and share the link: friends water it and compare collections.', cta: 'Share the farm' },
    href: '#/farm',
  },
  {
    id: 'limits',
    icon: '📈',
    zh: { title: '这周的额度够用吗？', body: '分析页预测周额度什么时候用完，提前安排大任务。', cta: '看看预测' },
    en: { title: 'Will this week’s limit last?', body: 'The analysis page forecasts when your weekly limit runs out, so you can plan big jobs.', cta: 'See the forecast' },
    href: '#/analysis',
  },
  {
    id: 'pet',
    icon: '🐾',
    zh: { title: '桌面宠物陪你写代码', body: '螃蟹会在桌面上随任务状态变化表情，任务完成会提醒你。', cta: '设置宠物' },
    en: { title: 'A desktop pet that codes along', body: 'The crab on your desktop reacts to your agents and tells you when a task is done.', cta: 'Set up the pet' },
    href: '#/settings',
  },
];
export const adOf = (id: string): HouseAd => HOUSE_ADS.find((a) => a.id === id) ?? HOUSE_ADS[0];

/** watching an ad to the end pays this many tokens, a few times a day */
export const AD_SECONDS = 15;
export const AD_REWARD = 100_000;
export const ADS_PER_DAY = 5;

export interface AdState {
  day: string;
  watched: number;
  /** the ad playing now */
  open?: { id: string; ad: string; startedAt: number };
}
