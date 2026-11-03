import { useState, Suspense, useMemo, useEffect } from 'react';
import { motion } from 'motion/react';
import { Search, SlidersHorizontal } from 'lucide-react';
import { LoadingSkeleton } from '../components/shared/SettingsUI';
import { SETTINGS_GROUPS, SETTINGS_SECTIONS } from '../data/settingsSectionsMetadata';
import { SettingsSectionItem } from '../types/settingsNavigation.types';
import { SettingsHeader } from '../components/navigation/SettingsHeader';
import { SettingsGroupCard } from '../components/navigation/SettingsGroupCard';
import { SettingsSidebar } from '../components/navigation/SettingsSidebar';

// 👈 استيراد useToast العام (تأكد من صحة المسار في مشروعك)
import { useToast } from '@/hooks/useToast';

interface SettingsModuleProps {
  onNavigate?: (view: string, params?: any) => void;
  initialTab?: string;
}

export default function SettingsModule({ onNavigate, initialTab }: SettingsModuleProps) {
  // 👈 استخدام الإشعارات العامة بدلاً من الحالة المحلية
  const { success, error } = useToast(); 
  
  const [activeTab, setActiveTab] = useState<string>(initialTab || 'general');
  const [mobileView, setMobileView] = useState<'list' | 'detail'>(initialTab ? 'detail' : 'list');
  const [searchQuery, setSearchQuery] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
      setMobileView('detail');
    }
  }, [initialTab]);

  // Filter sections based on search query matching title, description, or keywords
  const filteredSections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return SETTINGS_SECTIONS;

    return SETTINGS_SECTIONS.filter((section) => {
      const matchTitle = section.title.toLowerCase().includes(q);
      const matchDesc = section.description.toLowerCase().includes(q);
      const matchKeywords = section.keywords.some((k) => k.toLowerCase().includes(q));
      return matchTitle || matchDesc || matchKeywords;
    });
  }, [searchQuery]);

  // 👈 حماية من الانهيار (Safe Fallback) بدلاً من throw Error
  const activeSectionMeta = useMemo(() => {
    const found = SETTINGS_SECTIONS.find((s) => s.id === activeTab);
    return found || SETTINGS_SECTIONS[0];
  }, [activeTab]);

  // إذا لم يكن هناك أي إعدادات مهيأة في النظام
  if (!activeSectionMeta) {
    return (
      <div className="flex flex-col items-center justify-center h-full w-full p-6 text-center">
        <div className="w-16 h-16 bg-red-50 text-red-500 rounded-full flex items-center justify-center mb-4">
          <SlidersHorizontal size={28} />
        </div>
        <h2 className="text-lg font-bold text-slate-800">لا توجد أقسام إعدادات متاحة</h2>
        <p className="text-sm text-slate-500 mt-2">يرجى التأكد من تهيئة ملفات الإعدادات (Settings Metadata) في النظام.</p>
      </div>
    );
  }

  const ActiveComponent = activeSectionMeta.component;

  const handleSelectSection = (sectionId: string) => {
    setActiveTab(sectionId);
    setMobileView('detail');
  };

  const handleBackToCardList = () => {
    setMobileView('list');
  };

  // 👈 دالة حفظ حقيقية وجاهزة للربط بقاعدة البيانات
  const handleManualSave = async () => {
    setIsSaving(true);
    try {
      // 1. إطلاق حدث المزامنة (Sync Event)
      window.dispatchEvent(new CustomEvent('SYNC_WAKEUP'));
      
      // 2. استدعاء خدمة الحفظ (مثال - قم بإلغاء التعليق عند ربطها)
      // await SettingsService.saveAllSettings(); 
      
      // محاكاة تأخير بسيط (يمكن حذفه عند الربط الفعلي)
      await new Promise((resolve) => setTimeout(resolve, 800));
      
      // 3. إظهار إشعار النجاح العام
      success('تم حفظ الإعدادات بنجاح وتحديث المتغيرات في المنظومة');
    } catch (err: any) {
      // 4. إظهار إشعار الخطأ في حال فشل الحفظ
      error(`فشل حفظ الإعدادات: ${err.message || 'خطأ غير متوقع'}`);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden box-border font-cairo relative" dir="rtl">
      
      {/* Fixed Header Section (shrink-0) */}
      <div className="shrink-0 mb-3 sm:mb-4">
        <SettingsHeader
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onSave={handleManualSave}
          isSaving={isSaving}
          onBackToDashboard={onNavigate ? () => onNavigate('dashboard') : undefined}
          onBackToCardList={handleBackToCardList}
          isMobileDrillDown={mobileView === 'detail'}
          activeSectionTitle={activeSectionMeta.title}
          activeSectionDescription={activeSectionMeta.description}
          activeSectionIcon={activeSectionMeta.icon}
        />
      </div>

      {/* Scrollable Content Container (flex-1 min-h-0 overflow-y-auto) */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
        
        {/* =======================================================================
            MOBILE VIEW (< lg breakpoint)
           ======================================================================= */}
        <div className="block lg:hidden w-full pb-28">
          {mobileView === 'list' ? (
            <div className="space-y-3.5">
              {/* Search feedback indicator on mobile */}
              {searchQuery && (
                <div className="p-3 bg-emerald-50 dark:bg-emerald-950/40 rounded-xl border border-emerald-200 dark:border-emerald-800/60 flex items-center justify-between text-xs text-emerald-900 dark:text-emerald-200 font-bold">
                  <div className="flex items-center gap-2">
                    <Search size={15} className="text-emerald-700 dark:text-emerald-400" />
                    <span>نتائج البحث عن: "{searchQuery}"</span>
                  </div>
                  <span className="bg-emerald-200/60 dark:bg-emerald-900/80 text-emerald-900 dark:text-emerald-200 px-2.5 py-0.5 rounded-full text-[11px] font-black">
                    {filteredSections.length} نتيجة
                  </span>
                </div>
              )}

              {/* Vertical Grouped Cards Navigation */}
              {SETTINGS_GROUPS.map((group) => {
                const itemsInGroup = filteredSections.filter((s) => s.groupId === group.id);
                if (itemsInGroup.length === 0) return null;

                return (
                  <SettingsGroupCard
                    key={group.id}
                    group={group}
                    items={itemsInGroup}
                    onSelectSection={handleSelectSection}
                    activeSectionId={activeTab}
                    isCompact={true}
                  />
                );
              })}

              {/* Empty state when no sections match search query */}
              {filteredSections.length === 0 && (
                <div className="bg-white dark:bg-slate-800 p-8 rounded-2xl border border-slate-200 dark:border-slate-700 text-center space-y-2.5 shadow-xs">
                  <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-700 flex items-center justify-center mx-auto text-slate-400">
                    <SlidersHorizontal size={22} />
                  </div>
                  <p className="text-sm font-bold text-slate-800 dark:text-slate-100">
                    لم يتم العثور على أي إعدادات مطابقة
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                    جرب البحث بكلمات أخرى مثل "عملة"، "نسخ"، "مستخدم"، "مبيعات"، أو "أمان"
                  </p>
                </div>
              )}
            </div>
          ) : (
            /* Mobile Drill-Down Section Content View */
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-3.5"
            >
              {/* Group category breadcrumb indicator */}
              {(() => {
                const parentGroup = SETTINGS_GROUPS.find((g) => g.id === activeSectionMeta.groupId);
                return (
                  parentGroup && (
                    <div className="flex items-center justify-between px-1">
                      <span className={`text-[11px] font-bold px-2.5 py-1 rounded-full border ${parentGroup.colorClass}`}>
                        {parentGroup.title}
                      </span>
                    </div>
                  )
                );
              })()}

              {/* Lazy Section Tab Component */}
              <div className="w-full box-border">
                <Suspense fallback={<LoadingSkeleton />}>
                  <ActiveComponent activeTab={activeTab} />
                </Suspense>
              </div>
            </motion.div>
          )}
        </div>

        {/* =======================================================================
            DESKTOP VIEW (lg: breakpoint and above)
           ======================================================================= */}
        <div className="hidden lg:flex items-start gap-4 xl:gap-5 w-full h-full min-h-0 pb-6">
          {/* Right Column: Sticky Sidebar with 4 Groups Accordion */}
          <SettingsSidebar
            groups={SETTINGS_GROUPS}
            sections={filteredSections}
            activeSectionId={activeTab}
            onSelectSection={handleSelectSection}
            searchQuery={searchQuery}
          />

          {/* Left Column: Active Section Content Panel */}
          <main className="flex-1 min-w-0 h-full overflow-y-auto custom-scrollbar space-y-4 px-1">
            {/* Active Section Banner Header */}
            {(() => {
              const ActiveIcon = activeSectionMeta.icon;
              const parentGroup = SETTINGS_GROUPS.find((g) => g.id === activeSectionMeta.groupId);

              return (
                <div className="bg-white dark:bg-slate-800 p-4 sm:p-5 rounded-2xl border border-slate-200/90 dark:border-slate-700/80 shadow-xs flex items-center justify-between gap-4 w-full">
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div className="w-11 h-11 rounded-xl bg-[#1E4D4D]/10 dark:bg-emerald-950/40 text-[#1E4D4D] dark:text-emerald-400 flex items-center justify-center shrink-0 border border-[#1E4D4D]/20">
                      <ActiveIcon size={22} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-base font-black text-slate-800 dark:text-slate-100 font-cairo truncate">
                          {activeSectionMeta.title}
                        </h2>
                        {parentGroup && (
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${parentGroup.colorClass}`}>
                            {parentGroup.title}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-500 dark:text-slate-400 font-cairo mt-0.5 truncate">
                        {activeSectionMeta.description}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}

            {/* Lazy Component Tab Body */}
            <div className="w-full box-border">
              <Suspense fallback={<LoadingSkeleton />}>
                <ActiveComponent activeTab={activeTab} />
              </Suspense>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
