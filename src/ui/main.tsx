import { createRoot } from 'react-dom/client';
import { initToken } from './api';
import { detectLang } from './i18n';
import { Dashboard, I18nProvider, PetPage } from './App';
import { Gallery } from './components/Gallery';
import { FarmVisit } from './components/FarmSocial';
import './styles.css';

initToken();
const lang = detectLang();
document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
const isPet = location.hash.startsWith('#/pet');
const isGallery = location.hash.startsWith('#/gallery');
// someone's public farm, from its share link: no sign-in
const visit = /^#\/visit\/([a-z0-9]+)/.exec(location.hash)?.[1];

createRoot(document.getElementById('root')!).render(
  <I18nProvider initial={lang}>{visit ? <FarmVisit id={visit} /> : isGallery ? <Gallery /> : isPet ? <PetPage /> : <Dashboard />}</I18nProvider>,
);
