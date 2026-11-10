import React from 'react';
import { LogOut, Settings, LucideIcon, LoaderCircle } from 'lucide-react';
import { BackButton } from '@/components/shared/BackButton';
import { useAuth } from '@features/auth/hooks/useAuth';

interface SettingsHeaderProps {
  // تم جعل الخصائص القديمة اختيارية (Optional) لكي لا ينكسر الملف الأب SettingsModule
  searchQuery?: string;
  onSearchChange?: (val: string) => void;
  onSave?: () => void;
  isSaving?: boolean;
  onBackToDashboard?: () => void;
  onBackToCardList?: () => void;
  isMobileDrillDown?: boolean;
  activeSectionTitle?: string;
  activeSectionDescription?: string;
  activeSectionIcon?: React.ComponentType<any> | React.ElementType | LucideIcon;
  showSearch?: boolean;
}

export const SettingsHeader: React.FC<SettingsHeaderProps> = ({
  onBackToDashboard,
  onBackToCardList,
  isMobileDrillDown = false,
  activeSectionTitle,
  activeSectionDescription,
  activeSectionIcon: ActiveIcon = Settings,
}) => {
  // Determine back navigation action
  const handleBack = () => {
    if (isMobileDrillDown && onBackToCardList) {
      onBackToCardList();
    } else if (onBackToDashboard) {
      onBackToDashboard();
    }
  };

  const backTitle = isMobileDrillDown ? "العودة لقائمة الإعدادات" : "العودة للرئيسية";
  const displayTitle = isMobileDrillDown && activeSectionTitle ? activeSectionTitle : "الإعدادات";
  const displaySubtitle = isMobileDrillDown 
    ? (activeSectionDescription || "إدارة وتخصيص خيارات هذا القسم") 
    : "إدارة وضبط إعدادات النظام";

  const IconComponent = isMobileDrillDown && ActiveIcon ? ActiveIcon : Settings;
  const { signOut } = useAuth();
  const [isSigningOut, setIsSigningOut] = React.useState(false);

  const handleSignOut = async () => {
    if (isSigningOut) return;
    setIsSigningOut(true);
    try {
      await signOut();
    } finally {
      if (typeof window !== 'undefined') window.location.hash = '#/login';
      setIsSigningOut(false);
    }
  };

  return (
    <header 
      className="bg-gradient-to-r from-[#0A3D3A] via-[#0F4F4C] to-[#14534F] text-white border border-emerald-800/50 rounded-2xl sm:rounded-3xl shadow-md shadow-emerald-950/20 p-3 sm:p-4 box-border w-full shrink-0 transition-all"
      dir="rtl"
    >
      {/* Primary Top Bar: [Back Arrow] -> [Section Icon] -> [Title] */}
      <div className="flex items-center justify-between gap-2 sm:gap-4 w-full min-w-0">
        
        {/* Right Section (RTL Start): Navigation + Section Icon + Title */}
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          {/* Unified Back Button */}
          <BackButton
            onClick={handleBack}
            title={backTitle}
            variant="emerald"
            size="md"
          />

          {/* Section Icon container */}
          <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-emerald-950/70 text-emerald-300 flex items-center justify-center shrink-0 border border-emerald-500/30 shadow-inner">
            <IconComponent size={22} className="shrink-0 transition-transform duration-500 hover:rotate-45" />
          </div>

          {/* Section Name & Subtitle */}
          <div className="min-w-0 flex-1">
            <h1 className="text-sm sm:text-base md:text-lg font-black text-white font-cairo leading-tight truncate">
              {displayTitle}
            </h1>
            <p className="text-[11px] sm:text-xs text-emerald-100/75 font-cairo hidden sm:block truncate mt-0.5 font-medium">
              {displaySubtitle}
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => { void handleSignOut(); }}
          disabled={isSigningOut}
          aria-label="تسجيل الخروج"
          title="تسجيل الخروج"
          className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl border border-red-300/40 bg-red-500/10 px-2.5 sm:px-3 py-2 text-[11px] sm:text-xs font-bold text-white hover:bg-red-500/20 disabled:opacity-60 transition-colors"
        >
          {isSigningOut ? <LoaderCircle size={16} className="animate-spin" /> : <LogOut size={16} />}
          <span className="inline text-[10px] sm:text-xs">تسجيل الخروج</span>
        </button>
      </div>
    </header>
  );
};
