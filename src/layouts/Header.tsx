
import { useState, useEffect } from 'react';
import { db } from '@/core/db';
const defaultLogoImg = '/logo.png';
import { HeartPulse, Menu } from 'lucide-react';
import NotificationCenter from '@/components/shared/NotificationCenter';
import { SidebarMenu } from './SidebarMenu';

const DynamicLogo = () => {
  const [logoSrc, setLogoSrc] = useState<string | null>(null);
  const [hasError, setHasError] = useState(false);
  const [companyName, setCompanyName] = useState('PharmaFlow');

  useEffect(() => {
    const loadLogo = async () => {
      try {
        const config = await db.getSetting('invoice_config', null);

        if (config?.CompanyLogo) {
          setLogoSrc(config.CompanyLogo);
        } else {
          setLogoSrc(defaultLogoImg);
        }

        if (config?.CompanyName) {
          setCompanyName(config.CompanyName);
        }
      } catch (err) {
        setLogoSrc(defaultLogoImg);
      }
    };

    loadLogo();
  }, []);

  if (hasError || !logoSrc) {
    return (
      <div
        className="flex items-center gap-2 px-3 py-1 bg-emerald-50 dark:bg-emerald-950/40 rounded-xl border border-emerald-100 dark:border-emerald-800"
        dir="rtl"
      >
        <HeartPulse
          className="text-emerald-600 dark:text-emerald-400 shrink-0"
          size={24}
        />

        <div className="flex flex-col leading-tight whitespace-nowrap">
          <span className="font-black text-emerald-800 dark:text-emerald-300 text-base tracking-tight">
            {companyName}
          </span>

          <span className="text-[9px] font-bold text-emerald-600 dark:text-emerald-400">
            إدارة الصيدليات الذكية
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-center gap-2 px-2 sm:px-3 py-1 bg-emerald-50 dark:bg-emerald-950/40 rounded-xl border border-emerald-100 dark:border-emerald-800 max-w-full">
      <img
        src={logoSrc}
        alt={`${companyName} Logo`}
        loading="eager"
        className="h-8 sm:h-9 md:h-11 w-auto max-w-[48px] sm:max-w-[56px] object-contain shrink-0 transition-opacity duration-300"
        onError={() => {
          console.warn(
            '[Header DynamicLogo] Failed to load logo image:',
            logoSrc
          );

          if (logoSrc === defaultLogoImg) {
            setHasError(true);
          } else {
            setLogoSrc(defaultLogoImg);
          }
        }}
      />

      <div className="flex min-w-0 flex-col items-start leading-tight whitespace-nowrap">
        <span className="font-black text-emerald-800 dark:text-emerald-300 text-sm sm:text-base tracking-tight">
          {companyName}
        </span>

        <span className="text-[9px] sm:text-[10px] font-bold text-emerald-600 dark:text-emerald-400">
          إدارة الصيدليات الذكية
        </span>
      </div>
    </div>
  );
};

interface HeaderProps {
  pageTitle?: string;
  showBackButton?: boolean;
  onBackClick?: () => void;
  onMenuClick?: () => void;
  onNavigate?: (view: string, params?: any) => void;
  currentView?: string;
  isHome?: boolean;
}

const Header = ({
  pageTitle,
  showBackButton,
  onBackClick,
  onMenuClick,
  onNavigate,
  currentView,
  isHome,
}: HeaderProps) => {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  const [windowLocation, setWindowLocation] = useState(() => ({
    pathname: typeof window !== 'undefined' ? window.location.pathname : '/',
    hash: typeof window !== 'undefined' ? window.location.hash : '',
  }));

  useEffect(() => {
    const handleLocationChange = () => {
      setWindowLocation({
        pathname: window.location.pathname,
        hash: window.location.hash,
      });
    };

    window.addEventListener('popstate', handleLocationChange);
    window.addEventListener('hashchange', handleLocationChange);

    return () => {
      window.removeEventListener('popstate', handleLocationChange);
      window.removeEventListener('hashchange', handleLocationChange);
    };
  }, []);

  const activePathname = windowLocation.pathname;
  const activeHash = windowLocation.hash;

  // إظهار الشعار والهوية في الصفحة الرئيسية فقط.
  const isHomePage = Boolean(
    isHome ||
      currentView === 'dashboard' ||
      currentView === 'home' ||
      (!currentView &&
        (
          activePathname === '/' ||
          activePathname === '/home' ||
          activePathname === '/dashboard'
        ) &&
        (
          !activeHash ||
          activeHash === '#' ||
          activeHash === '#/' ||
          activeHash === '#/dashboard' ||
          activeHash === '#/home'
        ))
  );

  if (!isHomePage) {
    return null;
  }

  return (
    <header
      className="w-full w-[100vw] max-w-none bg-white dark:bg-slate-900 border-b border-gray-100 dark:border-slate-800 px-4 sm:px-6 sticky top-0 z-50 shadow-sm h-[64px] min-h-[64px] relative"
      style={{ width: '100vw', maxWidth: 'none', position: 'relative' }}
      dir="rtl"
    >
      <SidebarMenu
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        onNavigate={onNavigate}
      />

      {/* زر القائمة الجانبية */}
      <div className="absolute right-4 sm:right-6 top-1/2 -translate-y-1/2 z-10 flex items-center gap-2 md:gap-3">
        <button
          onClick={() => {
            if (onMenuClick) {
              onMenuClick();
            } else {
              setIsSidebarOpen(true);
            }
          }}
          className="w-10 h-10 flex items-center justify-center bg-slate-50 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-950/30 rounded-xl transition-all active:scale-95 cursor-pointer"
          title="القائمة"
          aria-label="القائمة"
        >
          <Menu size={20} />
        </button>
      </div>

      {/* شعار PharmaFlow الكامل — ظاهر على الهاتف والحاسوب */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-0 pointer-events-auto flex items-center justify-center max-w-[calc(100%-112px)]">
        <DynamicLogo />
      </div>

      {/* التنبيهات وأزرار الرجوع والعنوان */}
      <div className="absolute left-4 sm:left-6 top-1/2 -translate-y-1/2 z-10 flex items-center gap-2 md:gap-3">
        <NotificationCenter />

        {showBackButton && (
          <button
            onClick={onBackClick}
            className="text-2xl text-gray-600 dark:text-gray-300 hover:text-emerald-600 dark:hover:text-emerald-400 transition-all duration-300 transform hover:scale-110 p-2 rounded-full hover:bg-emerald-50 dark:hover:bg-emerald-950/30 flex items-center justify-center cursor-pointer"
            title="العودة"
            aria-label="العودة"
          >
            <span className="leading-none">➟</span>
          </button>
        )}

        <h1 className="text-base font-bold text-gray-800 dark:text-gray-100 hidden md:block">
          {pageTitle || 'PharmaFlow'}
        </h1>
      </div>
    </header>
  );
};

export default Header;
