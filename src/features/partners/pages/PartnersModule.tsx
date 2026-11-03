
import React, { useState, useMemo, useEffect } from 'react';
import { db } from '@/core/db';
import { useUI, useAccounting } from '@/contexts/AppContext';
import { Card, Button, Modal, Input } from '@/components/shared/SharedUI';
import { 
  Users, Search, MoreVertical, Phone, ArrowRight, 
  MapPin, CreditCard, UserPlus, ChevronLeft,
  TrendingUp, TrendingDown, UserCircle, Truck, Building2, BookOpen
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

interface PartnersModuleProps {
  onNavigate?: (view: any, params?: any) => void;
  subType?: string;
  initialTab?: string;
}

const mapSubTypeToTab = (type?: string): 'CUSTOMERS' | 'SUPPLIERS' | 'PARTNERS' | 'ALL' => {
  if (!type) return 'CUSTOMERS';
  const norm = type.toLowerCase();
  if (norm === 'supplier' || norm === 'suppliers') return 'SUPPLIERS';
  if (norm === 'customer' || norm === 'customers') return 'CUSTOMERS';
  if (norm === 'partner' || norm === 'partners') return 'PARTNERS';
  if (norm === 'all' || norm === 'directory' || norm === 'contacts') return 'ALL';
  return 'CUSTOMERS';
};

const PartnersModule: React.FC<PartnersModuleProps> = ({ onNavigate, subType, initialTab }) => {
  const { customers, suppliers, refreshAccounting } = useAccounting();
  const { currency, addToast } = useUI();
  
  const [activeTab, setActiveTab] = useState<'CUSTOMERS' | 'SUPPLIERS' | 'PARTNERS' | 'ALL'>(
    mapSubTypeToTab(subType || initialTab)
  );
  const [searchTerm, setSearchTerm] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingPartner, setEditingPartner] = useState<any>(null);

  useEffect(() => {
    if (subType || initialTab) {
      setActiveTab(mapSubTypeToTab(subType || initialTab));
    }
  }, [subType, initialTab]);

  const partners = useMemo(() => {
    if (activeTab === 'SUPPLIERS') {
      return suppliers.map((s: any) => ({ ...s, partnerCategory: 'SUPPLIER', categoryLabel: 'مورد' }));
    }
    if (activeTab === 'CUSTOMERS') {
      return customers.map((c: any) => ({ ...c, partnerCategory: 'CUSTOMER', categoryLabel: 'عميل' }));
    }
    if (activeTab === 'PARTNERS') {
      const customerPartners = customers
        .filter((c: any) => c.isPartner || c.type === 'partner' || c.Category === 'PARTNER' || (c.Customer_Name || '').includes('شريك'))
        .map((c: any) => ({ ...c, partnerCategory: 'PARTNER', categoryLabel: 'شريك عميل' }));

      const supplierPartners = suppliers
        .filter((s: any) => s.isPartner || s.type === 'partner' || s.Category === 'PARTNER' || (s.Supplier_Name || '').includes('شريك'))
        .map((s: any) => ({ ...s, partnerCategory: 'PARTNER', categoryLabel: 'شريك مورد' }));

      const combined = [...customerPartners, ...supplierPartners];
      if (combined.length > 0) return combined;

      return [
        ...customers.slice(0, 5).map((c: any) => ({ ...c, partnerCategory: 'PARTNER', categoryLabel: 'شريك / جهة مرتبطة' })),
        ...suppliers.slice(0, 5).map((s: any) => ({ ...s, partnerCategory: 'PARTNER', categoryLabel: 'شريك / جهة مرتبطة' }))
      ];
    }
    return [
      ...suppliers.map((s: any) => ({ ...s, partnerCategory: 'SUPPLIER', categoryLabel: 'مورد' })),
      ...customers.map((c: any) => ({ ...c, partnerCategory: 'CUSTOMER', categoryLabel: 'عميل' }))
    ];
  }, [activeTab, customers, suppliers]);

  const filteredPartners = useMemo(() => {
    if (!searchTerm.trim()) return partners;
    const term = searchTerm.toLowerCase();
    return partners.filter((p: any) => 
      (p.Customer_Name || p.Supplier_Name || '').toLowerCase().includes(term) ||
      (p.Phone || '').includes(term) ||
      (p.Address || '').toLowerCase().includes(term)
    );
  }, [partners, searchTerm]);

  const handleSave = async () => {
    try {
      const isSupplierMode = activeTab === 'SUPPLIERS' || (editingPartner?.category === 'SUPPLIER');
      if (isSupplierMode) {
        const data = {
          id: editingPartner.id || db.generateId('SUPP'),
          Supplier_ID: editingPartner.id || db.generateId('SUPP'),
          Supplier_Name: editingPartner.name,
          Phone: editingPartner.phone || '',
          Address: editingPartner.address || '',
          Tax_Number: editingPartner.taxNumber || '',
          Email: editingPartner.email || '',
          Balance: editingPartner.balance || 0,
          updatedAt: new Date().toISOString()
        };
        await db.saveSupplier(data);
      } else {
        const data = {
          id: editingPartner.id || db.generateId('CUST'),
          Customer_ID: editingPartner.id || db.generateId('CUST'),
          Customer_Name: editingPartner.name,
          Phone: editingPartner.phone || '',
          Address: editingPartner.address || '',
          Tax_Number: editingPartner.taxNumber || '',
          Email: editingPartner.email || '',
          Balance: editingPartner.balance || 0,
          isPartner: activeTab === 'PARTNERS' || editingPartner.isPartner || false,
          updatedAt: new Date().toISOString()
        };
        await db.saveCustomer(data);
      }
      addToast("تم حفظ البيانات بنجاح ✅", "success");
      
      refreshAccounting();
      setIsModalOpen(false);
      setEditingPartner(null);
    } catch (err: any) {
      addToast(err.message || "حدث خطأ أثناء الحفظ", "error");
    }
  };

  const getPartnerLabel = () => {
    switch (activeTab) {
      case 'SUPPLIERS': return 'مورد';
      case 'CUSTOMERS': return 'عميل';
      case 'PARTNERS': return 'شريك';
      case 'ALL': return 'جهة اتصال';
    }
  };

  const getHeaderTitle = () => {
    switch (activeTab) {
      case 'SUPPLIERS': return 'إدارة الموردين';
      case 'CUSTOMERS': return 'إدارة العملاء';
      case 'PARTNERS': return 'الشركاء والجهات المرتبطة';
      case 'ALL': return 'دليل جميع جهات الاتصال';
    }
  };

  const getHeaderDescription = () => {
    switch (activeTab) {
      case 'SUPPLIERS': return 'إدارة قائمة الموردين والشركات الموردة للأدوية والخدمات';
      case 'CUSTOMERS': return 'إدارة بيانات العملاء والحسابات المدينة والرصيد';
      case 'PARTNERS': return 'إدارة الشركاء والمستثمرين والجهات الطبيّة المرتبطة';
      case 'ALL': return 'الدليل الشامل الموحد لجميع جهات الاتصال والشركاء';
    }
  };

  return (
    <div className="p-4 md:p-8 space-y-8 bg-[#F8FAFA] min-h-full font-cairo" dir="rtl">
      {/* Header Section */}
      <button
        onClick={() => onNavigate?.('dashboard')}
        className="w-8 h-8 bg-slate-50 border border-slate-100 rounded-lg flex items-center justify-center text-[#1E4D4D] hover:bg-slate-100 transition-all shrink-0 mb-3"
        title="الرجوع للرئيسية"
      >
        <ArrowRight size={18} />
      </button>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#1E4D4D] p-4 rounded-2xl shadow-sm">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-11 h-11 bg-white/10 text-white rounded-xl flex items-center justify-center shrink-0">
            {activeTab === 'SUPPLIERS' ? <Truck size={24} /> : activeTab === 'PARTNERS' ? <Building2 size={24} /> : activeTab === 'ALL' ? <BookOpen size={24} /> : <Users size={24} />}
          </div>
          <div className="min-w-0">
            <h2 className="text-lg font-black text-white tracking-tight">{getHeaderTitle()}</h2>
            <p className="text-[11px] font-bold text-white/70 leading-relaxed mt-1">{getHeaderDescription()}</p>
          </div>
        </div>
      </div>

      {/* Horizontal partner tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
        <button onClick={() => setActiveTab('CUSTOMERS')} className={`shrink-0 px-5 py-2.5 rounded-full text-xs font-black transition-colors ${activeTab === 'CUSTOMERS' ? 'bg-[#1E4D4D] text-white' : 'bg-slate-100 text-slate-500'}`}>العملاء</button>
        <button onClick={() => setActiveTab('SUPPLIERS')} className={`shrink-0 px-5 py-2.5 rounded-full text-xs font-black transition-colors ${activeTab === 'SUPPLIERS' ? 'bg-[#1E4D4D] text-white' : 'bg-slate-100 text-slate-500'}`}>الموردون</button>
        <button onClick={() => setActiveTab('PARTNERS')} className={`shrink-0 px-5 py-2.5 rounded-full text-xs font-black transition-colors ${activeTab === 'PARTNERS' ? 'bg-[#1E4D4D] text-white' : 'bg-slate-100 text-slate-500'}`}>الشركاء / الجهات المرتبطة</button>
        <button onClick={() => setActiveTab('ALL')} className={`shrink-0 px-5 py-2.5 rounded-full text-xs font-black transition-colors ${activeTab === 'ALL' ? 'bg-[#1E4D4D] text-white' : 'bg-slate-100 text-slate-500'}`}>دليل جهات الاتصال</button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-row items-center gap-2">
        <div className="relative flex-1 min-w-0 group">
          <Search className="absolute right-4 top-1/2 -translate-y-1/2 text-slate-300 group-focus-within:text-[#1E4D4D] transition-colors" size={18} />
          <input 
            type="text" 
            placeholder={`البحث في قائمة ${getPartnerLabel()}ين...`}
            className="w-full h-12 bg-white border border-slate-100 rounded-xl pr-11 pl-4 text-[11px] font-black outline-none focus:border-[#1E4D4D] shadow-sm transition-all"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>
        <button 
          onClick={() => { setEditingPartner({}); setIsModalOpen(true); }}
          className="w-12 h-12 shrink-0 bg-[#1E4D4D] text-white rounded-xl flex items-center justify-center shadow-sm hover:bg-[#163D3D] active:scale-95 transition-all"
          title={`إضافة ${getPartnerLabel()} جديد`}
          aria-label={`إضافة ${getPartnerLabel()} جديد`}
        >
          <UserPlus size={20} />
        </button>
      </div>

      {/* Partner list */}
      <div className="bg-white rounded-2xl border border-slate-100 shadow-sm overflow-hidden">
        {filteredPartners.length > 0 ? (
          <AnimatePresence mode="popLayout">
            {filteredPartners.map((p: any, idx: number) => {
              const id = p.Customer_ID || p.Supplier_ID || p.id;
              const name = p.Customer_Name || p.Supplier_Name || p.name;
              const balance = p.balance || p.Balance || 0;
              const categoryLabel = p.categoryLabel || getPartnerLabel();

              return (
                <motion.div
                  key={id + '-' + idx}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.18 }}
                  className="flex items-center gap-3 px-4 py-4 border-b border-slate-100 last:border-b-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <h3 className="text-sm font-black text-slate-800 truncate">{name}</h3>
                      <span className="shrink-0 text-[9px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{categoryLabel}</span>
                    </div>
                    <p className="text-[11px] text-slate-400 mt-1 flex items-center gap-1"><Phone size={11} />{p.Phone || '---'}</p>
                  </div>

                  <div className="shrink-0 text-left min-w-[82px]">
                    <p className="text-[10px] text-slate-400 mb-1">الرصيد الحالي</p>
                    <p className={`text-xs font-black ${balance > 0 ? 'text-red-500' : balance < 0 ? 'text-emerald-600' : 'text-slate-600'}`}>
                      {Math.abs(balance).toLocaleString()} <span className="text-[10px] opacity-60 font-normal">{currency}</span>
                    </p>
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => { setEditingPartner({ id, name, phone: p.Phone, address: p.Address, taxNumber: p.Tax_Number, email: p.Email, balance, category: p.partnerCategory }); setIsModalOpen(true); }}
                      className="w-9 h-9 flex items-center justify-center text-slate-400 hover:text-[#1E4D4D] hover:bg-slate-50 rounded-lg transition-colors"
                      title="تعديل البيانات"
                      aria-label="تعديل البيانات"
                    >
                      <MoreVertical size={17} />
                    </button>
                    <button
                      onClick={() => onNavigate?.(p.partnerCategory === 'SUPPLIER' || activeTab === 'SUPPLIERS' ? 'purchases' : 'sales')}
                      className="hidden sm:flex h-9 px-2 items-center justify-center text-[10px] font-bold text-slate-500 hover:text-[#1E4D4D] rounded-lg transition-colors"
                    >
                      فاتورة
                    </button>
                    <button
                      onClick={() => onNavigate?.('aging-report')}
                      className="w-9 h-9 flex items-center justify-center text-[#1E4D4D] bg-slate-50 hover:bg-[#1E4D4D]/10 rounded-lg transition-colors"
                      title="كشف الحساب"
                      aria-label="كشف الحساب"
                    >
                      <ChevronLeft size={20} />
                    </button>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
        ) : (
          <div className="flex flex-col items-center justify-center text-center px-6 py-14">
            {activeTab === 'SUPPLIERS' ? <Truck size={48} className="text-slate-200 mb-4" /> : <Users size={48} className="text-slate-200 mb-4" />}
            <p className="text-sm font-bold text-slate-400">لا توجد بيانات مسجلة حالياً. اضغط على زر الإضافة للبدء.</p>
          </div>
        )}
      </div>

      {/* Modal - New/Edit Partner */}
      <AnimatePresence>
        {isModalOpen && (
          <Modal isOpen={isModalOpen} onClose={() => { setIsModalOpen(false); setEditingPartner(null); }} title={`${editingPartner?.id ? 'تعديل' : 'إضافة'} بيانات ${getPartnerLabel()}`} noPadding positionClass="items-center !p-4">
            <div className="max-h-[90vh] overflow-y-auto overscroll-contain px-4 pt-1 pb-4 space-y-2">
               <div className="space-y-2">
                  <div className="space-y-1 mt-1">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">اسم {getPartnerLabel()}</label>
                    <Input 
                      value={editingPartner?.name || ''} 
                      onChange={e => setEditingPartner({...editingPartner, name: e.target.value})} 
                      placeholder="الاسم بالكامل..." 
                      className="!h-10 !text-sm focus:!border-[#1E4D4D]"
                    />
                  </div>

                  <div className="w-full h-px bg-slate-200 my-2"></div>

                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">رقم الهاتف</label>
                      <Input 
                        value={editingPartner?.phone || ''} 
                        onChange={e => setEditingPartner({...editingPartner, phone: e.target.value})} 
                        placeholder="05xxxxxxxx" 
                        className="!h-10 !text-sm"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">الرقم الضريبي</label>
                      <Input 
                        value={editingPartner?.taxNumber || ''} 
                        onChange={e => setEditingPartner({...editingPartner, taxNumber: e.target.value})} 
                        placeholder="VAT Registration..." 
                        className="!h-10 !text-sm"
                      />
                    </div>
                  </div>

                  <div className="w-full h-px bg-slate-200 my-2"></div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">البريد الإلكتروني</label>
                    <Input 
                      value={editingPartner?.email || ''} 
                      onChange={e => setEditingPartner({...editingPartner, email: e.target.value})} 
                      placeholder="email@example.com" 
                      className="!h-10 !text-sm"
                    />
                  </div>

                  <div className="w-full h-px bg-slate-200 my-2"></div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">العنوان</label>
                    <textarea 
                      rows={2} className="w-full bg-slate-50 border border-slate-100 rounded-xl px-3 py-2 text-sm font-bold text-[#1E4D4D] outline-none h-20 resize-none focus:bg-white focus:border-[#1E4D4D] transition-all"
                      value={editingPartner?.address || ''} 
                      onChange={e => setEditingPartner({...editingPartner, address: e.target.value})} 
                      placeholder="العنوان الكامل للشريك..."
                    />
                  </div>

                  <div className="w-full h-px bg-slate-200 my-2"></div>

                  <div className="space-y-1">
                    <label className="text-[11px] font-black text-slate-400 uppercase tracking-widest mr-2">الرصيد الافتتاحي</label>
                    <Input 
                      type="number" 
                      value={editingPartner?.balance || 0} 
                      onChange={e => setEditingPartner({...editingPartner, balance: parseFloat(e.target.value) || 0})} 
                      className="!h-10 !text-sm !text-blue-600 font-black"
                    />
                  </div>
               </div>

               <div className="flex flex-row gap-2 pt-2">
                  <Button variant="neutral" className="flex-1 !h-10 !rounded-xl !text-sm" onClick={() => setIsModalOpen(false)}>إلغاء</Button>
                  <Button variant="primary" className="flex-1 !h-10 !rounded-xl !text-sm shadow-md shadow-emerald-900/10" onClick={handleSave}>حفظ البيانات ✅</Button>
               </div>
            </div>
          </Modal>
        )}
      </AnimatePresence>
    </div>
  );
};

export default PartnersModule;
