import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  X, Settings, CreditCard, 
  ChevronDown, ChevronUp,
  Printer, LogOut,
  Upload, Phone, LifeBuoy, Users, Moon, Sun, Globe,
  PackageCheck, Sliders, Truck, Clock,
  FileText, Scale, ArrowRightLeft, BarChart2,
  Landmark
} from 'lucide-react';
import { useTheme } from '@/contexts/ThemeContext';
import { useUI } from '@/contexts/AppContext';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { can } from '@/utils/permissions';

interface SidebarMenuProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate?: (view: string, params?: any) => void;
}

const AccordionSection = ({ title, icon: Icon, children, defaultOpen = false }: any) => {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-gray-100 dark:border-gray-700/50">
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors focus:outline-none cursor-pointer"
      >
        <div className="flex items-center gap-3 text-[#1E4D4D] dark:text-emerald-400 font-bold">
          <Icon size={18} />
          <span className="text-sm font-cairo">{title}</span>
        </div>
        {isOpen ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
      </button>
      <AnimatePresence>
        {isOpen && (
          <motion.div 
            initial={{ height: 0, opacity: 0 }} 
            animate={{ height: 'auto', opacity: 1 }} 
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden bg-gray-50/30 dark:bg-gray-900/30"
          >
            <div className="p-3 space-y-2 font-cairo">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const SidebarMenu: React.FC<SidebarMenuProps> = ({ isOpen, onClose, onNavigate }) => {
  const { resolvedTheme, setThemeMode } = useTheme();
  const { currency, setCurrency } = useUI();
  const { signOut, profile } = useAuth();
  const isDarkMode = resolvedTheme === 'dark';

  const handleNavClick = (view: string, params?: any) => {
    onClose();
    if (onNavigate) {
      onNavigate(view, params);
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div 
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/40 backdrop-blur-sm z-[200]"
          />
          <motion.div 
            initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed inset-y-0 right-0 h-full h-dvh w-[350px] max-w-[90vw] bg-white dark:bg-gray-900 shadow-2xl z-[201] flex flex-col font-cairo overflow-hidden"
            dir="rtl"
          >
            <div className="p-4 border-b dark:border-gray-800 flex items-center justify-between bg-[#1E4D4D] text-white shrink-0">
              <div className="flex items-center gap-2">
                <Settings size={20} className="text-emerald-400" />
                <h2 className="font-bold text-lg">النافذة التشغيلية والخدمات</h2>
              </div>
              <button onClick={onClose} className="p-1.5 hover:bg-white/20 rounded-lg transition-colors focus:outline-none cursor-pointer"><X size={20} /></button>
            </div>
            
            <div className="flex-1 overflow-y-auto custom-scrollbar">
              {/* ⚡ Quick Preferences Card */}
              <div className="p-4 bg-emerald-50/50 dark:bg-emerald-950/20 border-b border-emerald-100 dark:border-emerald-900/40 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-black text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                    {isDarkMode ? <Moon size={15} className="text-indigo-400" /> : <Sun size={15} className="text-amber-500" />}
                    مظهر النظام
                  </span>
                  <div className="flex items-center bg-white dark:bg-gray-800 p-0.5 rounded-lg border border-gray-200 dark:border-gray-700">
                    <button
                      type="button"
                      onClick={() => setThemeMode('light')}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1 cursor-pointer ${
                        !isDarkMode 
                          ? 'bg-emerald-600 text-white shadow-sm' 
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      <Sun size={13} />
                      نهاري
                    </button>
                    <button
                      type="button"
                      onClick={() => setThemeMode('dark')}
                      className={`px-2.5 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1 cursor-pointer ${
                        isDarkMode 
                          ? 'bg-emerald-600 text-white shadow-sm' 
                          : 'text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
                      }`}
                    >
                      <Moon size={13} />
                      ليلي
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-xs font-black text-emerald-800 dark:text-emerald-300 flex items-center gap-1.5">
                    <Globe size={15} className="text-emerald-600 dark:text-emerald-400" />
                    عملة النظام
                  </span>
                  <select
                    value={currency || 'YER'}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="text-xs p-1.5 px-2.5 border border-emerald-200 dark:border-emerald-800 rounded-lg bg-white dark:bg-gray-800 text-emerald-950 dark:text-emerald-100 font-bold focus:ring-2 focus:ring-[#10B981] outline-none transition-all cursor-pointer shadow-xs"
                  >
                    <option value="YER">ريال يمني (YER)</option>
                    <option value="SAR">ريال سعودي (SAR)</option>
                    <option value="USD">دولار أمريكي (USD)</option>
                    <option value="AED">درهم إماراتي (AED)</option>
                    <option value="EGP">جنيه مصري (EGP)</option>
                  </select>
                </div>
              </div>

              {/* 1️⃣ Operational Partners & Services */}
              <AccordionSection title="قسم إدارة العملاء والشركاء" icon={Users} defaultOpen={true}>
                <button 
                  onClick={() => handleNavClick('partners')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <Users size={16} className="text-emerald-600 dark:text-emerald-400" />
                  <span>العملاء والموردون والشركاء</span>
                </button>
              </AccordionSection>

              {/* 2️⃣ Advanced Inventory Management */}
              <AccordionSection title="قسم إدارة المخزون المتقدم" icon={Truck}>
                <button 
                  onClick={() => handleNavClick('inventory-audit')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <PackageCheck size={16} className="text-teal-600 dark:text-teal-400" />
                  <span>جرد المخزون والتحقق</span>
                </button>
                <button 
                  onClick={() => handleNavClick('adjustments-registry')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <Sliders size={16} className="text-indigo-600 dark:text-indigo-400" />
                  <span>تسوية المخزون</span>
                </button>
              </AccordionSection>

              {/* 3️⃣ Advanced Accounting & Finance */}
              <AccordionSection title="قسم المحاسبة والمالية المتقدم" icon={FileText}>
                <button 
                  onClick={() => handleNavClick('reports/financial-engine')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <BarChart2 size={16} className="text-[#1E4D4D] dark:text-emerald-400" />
                  <span>مركز التقارير والذكاء المالي الموحد</span>
                </button>
                <button 
                  onClick={() => handleNavClick('reconciliation')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <Scale size={16} className="text-emerald-600 dark:text-emerald-400" />
                  <span>تسوية الحسابات</span>
                </button>
                <button 
                  onClick={() => handleNavClick('aging-report')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <Clock size={16} className="text-rose-600 dark:text-rose-400" />
                  <span>تقارير أعمار الديون</span>
                </button>
              </AccordionSection>

              {/* 4️⃣ Branch Management */}
              <AccordionSection title="قسم إدارة الفروع والصيدليات" icon={ArrowRightLeft}>
                <button 
                  onClick={() => handleNavClick('branches')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <ArrowRightLeft size={16} className="text-[#10B981]" />
                  <span>إدارة الفروع والصيدليات</span>
                </button>
              </AccordionSection>

              {/* قسم والتكامل المالي الموحد */}
              <AccordionSection title="قسم التكامل المالي الموحد" icon={Landmark}>
                <button 
                  onClick={() => handleNavClick('consolidation')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <Landmark size={16} className="text-emerald-600 dark:text-emerald-400" />
                  <span>المركز المالي الموحد</span>
                </button>
              </AccordionSection>

              {/* 5️⃣ Smart Branch Analytics */}
              <AccordionSection title="قسم تحليلات الفروع الذكية" icon={BarChart2}>
                <button 
                  onClick={() => handleNavClick('branch-reports')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <BarChart2 size={16} className="text-indigo-600 dark:text-indigo-400" />
                  <span>تقارير وتحليلات الفروع</span>
                </button>
              </AccordionSection>

              {/* 5️⃣ Drug Transfers Section */}
              <AccordionSection title="قسم التحويل الدوائي بين الفروع" icon={ArrowRightLeft}>
                <button 
                  onClick={() => handleNavClick('branch-transfers')}
                  className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                >
                  <ArrowRightLeft size={16} className="text-blue-600 dark:text-blue-400" />
                  <span>التحويلات بين الفروع</span>
                </button>
              </AccordionSection>

              {/* 7️⃣ Settings */}
              {(!profile?.role || can(profile?.role, 'MANAGE_SYSTEM')) && (
                <AccordionSection title="إعدادات المنظومة" icon={Settings}>
                  <div className="space-y-1">
                    <button 
                      onClick={() => handleNavClick('settings')}
                      className="w-full text-right text-xs font-bold text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 p-2.5 rounded-lg border border-gray-100 dark:border-gray-700/60 transition-colors flex items-center gap-2.5 cursor-pointer"
                    >
                      <Settings size={16} className="text-emerald-600 dark:text-emerald-400" />
                      <span>الإعدادات</span>
                    </button>
                  </div>
                </AccordionSection>
              )}

              {/* Pharmacy Info & Printing Config */}
              <AccordionSection title="بيانات الصيدلية والطباعة" icon={Printer}>
                <div className="space-y-3">
                  <input type="text" placeholder="اسم الصيدلية" className="w-full text-sm p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-[#10B981] outline-none transition-all" />
                  <input type="text" placeholder="العنوان" className="w-full text-sm p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-[#10B981] outline-none transition-all" />
                  <div className="grid grid-cols-2 gap-2">
                    <input type="tel" placeholder="رقم الهاتف" className="w-full text-sm p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-[#10B981] outline-none transition-all" />
                    <input type="text" placeholder="الرقم الضريبي" className="w-full text-sm p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-[#10B981] outline-none transition-all" />
                  </div>
                </div>

                <button className="w-full mt-3 flex items-center justify-center gap-2 text-sm text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 py-2.5 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors focus:outline-none cursor-pointer">
                  <Upload size={16} /> رفع شعار الصيدلية (Logo)
                </button>

                <div className="space-y-2 pt-3 border-t border-gray-100 dark:border-gray-700/50 mt-3">
                  <label className="text-xs font-bold text-gray-500 dark:text-gray-400">قياس ورق الفاتورة الافتراضي</label>
                  <select className="w-full text-sm p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-[#10B981] outline-none transition-all cursor-pointer">
                    <option value="80mm">ورق حراري 80mm</option>
                    <option value="a4">ورق A4</option>
                    <option value="a5">ورق A5</option>
                  </select>
                  <input type="text" placeholder="تذييل الفاتورة (مثال: البضاعة المباعة لا ترد)" className="w-full text-sm p-2.5 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 focus:ring-2 focus:ring-[#10B981] outline-none transition-all mt-2" />
                </div>
              </AccordionSection>

              {/* Subscription & Technical Support */}
              <AccordionSection title="الحسابات والاشتراك" icon={CreditCard}>
                <div className="bg-gradient-to-br from-[#1E4D4D] to-[#2A6B6B] p-4 rounded-xl text-white shadow-lg relative overflow-hidden">
                  <div className="absolute top-0 left-0 w-full h-full bg-white/5 opacity-50 pointer-events-none" style={{ backgroundImage: 'radial-gradient(circle at 2px 2px, white 1px, transparent 0)', backgroundSize: '16px 16px' }} />
                  <div className="relative z-10 space-y-2.5">
                    <div className="flex justify-between items-center">
                      <span className="text-emerald-200 text-xs font-bold">نوع الباقة</span>
                      <span className="font-bold text-xs bg-white/20 px-2 py-0.5 rounded text-white border border-white/10">بروفيشنال</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-emerald-200 text-xs font-bold">حالة الاشتراك</span>
                      <span className="font-bold text-xs flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.8)]"></span>نشط</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-emerald-200 text-xs font-bold">تاريخ الانتهاء</span>
                      <span className="font-bold text-xs">2026/12/31</span>
                    </div>
                  </div>
                </div>

                <button className="w-full mt-4 bg-gradient-to-r from-emerald-500 to-emerald-600 hover:from-emerald-600 hover:to-emerald-700 text-white text-sm py-2.5 rounded-lg font-bold shadow-md hover:shadow-lg transition-all flex items-center justify-center gap-2 focus:outline-none cursor-pointer">
                  <CreditCard size={18} /> ترقية / تجديد الاشتراك
                </button>

                <div className="pt-4 border-t border-gray-100 dark:border-gray-700/50 mt-4">
                  <p className="text-xs font-bold text-gray-500 dark:text-gray-400 mb-3">الدعم الفني السريع</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button className="flex flex-col items-center justify-center gap-2 text-xs font-bold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 py-3 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors focus:outline-none cursor-pointer">
                      <Phone size={18} className="text-blue-500" /> اتصال بالدعم
                    </button>
                    <button className="flex flex-col items-center justify-center gap-2 text-xs font-bold text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 py-3 rounded-lg hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors focus:outline-none cursor-pointer">
                      <LifeBuoy size={18} className="text-orange-500" /> تذكرة صيانة
                    </button>
                  </div>
                </div>
              </AccordionSection>
            </div>

            <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 mt-auto shrink-0">
              <button 
                onClick={() => {
                  onClose();
                  void signOut().catch((logoutError) => {
                    console.error('[SidebarMenu] Logout failed:', logoutError);
                  }).finally(() => {
                    window.location.hash = '#/login';
                  });
                }} 
                className="flex items-center justify-center gap-2 text-red-600 dark:text-red-400 text-sm font-bold w-full py-2.5 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors focus:outline-none cursor-pointer"
              >
                <LogOut size={18} /> تسجيل الخروج
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
};
