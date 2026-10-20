import React, { useState } from 'react';
import { 
  Package, 
  ShoppingCart, 
  TrendingUp, 
  ShieldCheck, 
  Users, 
  Activity, 
  AlertTriangle, 
  Cpu, 
  BarChart3,
  Server,
  Plus
} from 'lucide-react';

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  const [searchQuery, setSearchQuery] = useState('');
  const [cart, setCart] = useState([]);

  const inventory = [
    { id: 1, name: 'باراسيتامول 500 ملغ', stock: 1250, price: 15.0, branch: 'الفرع الرئيسي - الرياض', expiry: '2027-05', status: 'متوفر' },
    { id: 2, name: 'أوميبرازول 20 ملغ', stock: 420, price: 45.0, branch: 'فرع المروج', expiry: '2026-11', status: 'متوفر' },
    { id: 3, name: 'أموكسيسيلين 250 ملغ', stock: 85, price: 32.5, branch: 'الفرع الرئيسي - الرياض', expiry: '2026-08', status: 'منخفض' },
    { id: 4, name: 'إنسولين لانتوس', stock: 15, price: 180.0, branch: 'فرع النزهة', expiry: '2026-06', status: 'حرج' },
    { id: 5, name: 'فيتامين د3 10000 وحدة', stock: 630, price: 65.0, branch: 'فرع المروج', expiry: '2028-01', status: 'متوفر' }
  ];

  const addToCart = (item) => {
    setCart(prev => {
      const existing = prev.find(i => i.id === item.id);
      if (existing) {
        return prev.map(i => i.id === item.id ? { ...i, qty: i.qty + 1 } : i);
      }
      return [...prev, { ...item, qty: 1 }];
    });
  };

  const totalCart = cart.reduce((sum, item) => sum + (item.price * item.qty), 0);

  return (
    <div className="min-h-screen bg-slate-100 flex flex-col font-sans text-slate-800" dir="rtl">
      {/* Top Header */}
      <header className="bg-slate-900 text-white shadow-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center space-x-3 space-x-reverse">
            <div className="bg-emerald-600 p-2 rounded-xl text-white shadow-lg flex items-center justify-center">
              <Package className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight">PharmaFlow Pro</h1>
              <p className="text-xs text-slate-400">نظام إدارة الصيدليات المتقدم والأمن الموحد</p>
            </div>
          </div>
          <div className="flex items-center space-x-4 space-x-reverse">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              <span className="w-2 h-2 ml-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
              متصل بالنسخ المتماثل الآمن (TLS 1.3)
            </span>
            <div className="flex items-center space-x-2 space-x-reverse bg-slate-800 px-3 py-1.5 rounded-lg border border-slate-700">
              <Users className="w-4 h-4 text-slate-400" />
              <span className="text-sm font-medium">مدير النظام (Admin)</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Navigation */}
      <nav className="bg-white border-b border-slate-200 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 flex space-x-1 space-x-reverse overflow-x-auto">
          {[
            { id: 'dashboard', label: 'لوحة القيادة', icon: BarChart3 },
            { id: 'inventory', label: 'المخزون والأدوية', icon: Package },
            { id: 'pos', label: 'نقاط البيع (POS)', icon: ShoppingCart },
            { id: 'ai', label: 'مساعد الذكاء الاصطناعي', icon: Cpu },
            { id: 'replication', label: 'المزامنة والنسخ المتماثل', icon: Server }
          ].map(tab => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 space-x-reverse px-5 py-3.5 border-b-2 font-medium text-sm transition-colors whitespace-nowrap ${
                  isActive 
                    ? 'border-emerald-600 text-emerald-600 bg-emerald-50/50' 
                    : 'border-transparent text-slate-600 hover:text-slate-900 hover:bg-slate-50'
                }`}
              >
                <Icon className="w-4 h-4" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Content Area */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6">
        {activeTab === 'dashboard' && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {[
                { title: 'إجمالي المبيعات اليومية', value: '48,250 ر.س', change: '+12.4%', icon: TrendingUp, color: 'text-emerald-600', bg: 'bg-emerald-50' },
                { title: 'الطلبات والوصفات', value: '342 طلب', change: '+5.1%', icon: ShoppingCart, color: 'text-blue-600', bg: 'bg-blue-50' },
                { title: 'أدوية منخفضة المخزون', value: '14 صنف', change: 'تحذير', icon: AlertTriangle, color: 'text-amber-600', bg: 'bg-amber-50' },
                { title: 'الفروع النشطة', value: '8 فروع', change: 'متصلة بالكامل', icon: ShieldCheck, color: 'text-purple-600', bg: 'bg-purple-50' }
              ].map((stat, i) => {
                const Icon = stat.icon;
                return (
                  <div key={i} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex items-center justify-between">
                    <div>
                      <p className="text-sm font-medium text-slate-500">{stat.title}</p>
                      <h3 className="text-2xl font-bold text-slate-900 mt-1">{stat.value}</h3>
                      <span className="inline-block mt-2 text-xs font-semibold text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded">
                        {stat.change}
                      </span>
                    </div>
                    <div className={`${stat.bg} ${stat.color} p-4 rounded-xl`}>
                      <Icon className="w-7 h-7" />
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="lg:col-span-2 bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h3 className="text-lg font-bold text-slate-900 mb-4">حركة المبيعات الأسبوعية</h3>
                <div className="h-64 flex items-end justify-between gap-4 pt-6 border-b border-slate-100">
                  {[40, 65, 55, 80, 95, 70, 85].map((val, idx) => (
                    <div key={idx} className="flex-1 flex flex-col items-center gap-2">
                      <div className="w-full bg-emerald-500 rounded-t-lg transition-all duration-500 hover:bg-emerald-600" style={{ height: `${val}%` }}></div>
                      <span className="text-xs text-slate-500 font-medium">اليوم {idx + 1}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                <h3 className="text-lg font-bold text-slate-900 mb-4">حالة الأمان والنسخ المتماثل</h3>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <div className="flex items-center space-x-3 space-x-reverse">
                      <ShieldCheck className="w-5 h-5 text-emerald-600" />
                      <span className="text-sm font-medium">تشفير قاعدة البيانات</span>
                    </div>
                    <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-1 rounded font-bold">AES-256</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <div className="flex items-center space-x-3 space-x-reverse">
                      <Activity className="w-5 h-5 text-blue-600" />
                      <span className="text-sm font-medium">حماية Anti-Loopback</span>
                    </div>
                    <span className="text-xs bg-blue-100 text-blue-700 px-2 py-1 rounded font-bold">مفعلة</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <div className="flex items-center space-x-3 space-x-reverse">
                      <Server className="w-5 h-5 text-purple-600" />
                      <span className="text-sm font-medium">مستأجر الفروع (Tenant ID)</span>
                    </div>
                    <span className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded font-bold">معزول صارم</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'inventory' && (
          <div className="space-y-6">
            <div className="flex justify-between items-center bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
              <div className="relative flex-1 max-w-md">
                <input 
                  type="text" 
                  placeholder="ابحث عن اسم الدواء، الباركود، أو الفرع..." 
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="w-full pr-4 pl-4 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-emerald-600 text-sm"
                />
              </div>
              <button className="bg-emerald-600 text-white px-4 py-2 rounded-xl text-sm font-medium hover:bg-emerald-700 transition-colors flex items-center space-x-2 space-x-reverse">
                <Plus className="w-4 h-4" />
                <span>إضافة دواء جديد</span>
              </button>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-right border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200 text-slate-600 text-xs font-bold uppercase">
                    <th className="p-4">اسم الدواء</th>
                    <th className="p-4">المخزون</th>
                    <th className="p-4">السعر (ر.س)</th>
                    <th className="p-4">الفرع</th>
                    <th className="p-4">تاريخ الصلاحية</th>
                    <th className="p-4">الحالة</th>
                    <th className="p-4">إجراءات</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {inventory.filter(item => item.name.includes(searchQuery) || item.branch.includes(searchQuery)).map(item => (
                    <tr key={item.id} className="hover:bg-slate-50/50">
                      <td className="p-4 font-semibold text-slate-900">{item.name}</td>
                      <td className="p-4">{item.stock} وحدة</td>
                      <td className="p-4">{item.price.toFixed(2)} ر.س</td>
                      <td className="p-4 text-slate-600">{item.branch}</td>
                      <td className="p-4 text-slate-500">{item.expiry}</td>
                      <td className="p-4">
                        <span className={`px-2.5 py-1 rounded-full text-xs font-semibold ${
                          item.status === 'متوفر' ? 'bg-emerald-100 text-emerald-800' :
                          item.status === 'منخفض' ? 'bg-amber-100 text-amber-800' : 'bg-rose-100 text-rose-800'
                        }`}>
                          {item.status}
                        </span>
                      </td>
                      <td className="p-4">
                        <button 
                          onClick={() => addToCart(item)}
                          className="bg-slate-100 text-slate-700 hover:bg-emerald-600 hover:text-white px-3 py-1.5 rounded-lg text-xs font-medium transition-colors"
                        >
                          إضافة للبيع
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'pos' && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-2 space-y-4">
              <div className="bg-white p-4 rounded-2xl shadow-sm border border-slate-200">
                <h3 className="font-bold text-slate-900 mb-3">اختر الأدوية لإتمام الفاتورة السريعة</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {inventory.map(item => (
                    <div key={item.id} className="border border-slate-200 p-4 rounded-xl flex justify-between items-center bg-slate-50/50 hover:border-emerald-600 transition-colors">
                      <div>
                        <h4 className="font-bold text-slate-900">{item.name}</h4>
                        <p className="text-xs text-slate-500">{item.price} ر.س | متوفر: {item.stock}</p>
                      </div>
                      <button 
                        onClick={() => addToCart(item)}
                        className="bg-emerald-600 text-white p-2 rounded-lg hover:bg-emerald-700 transition-colors"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 flex flex-col justify-between">
              <div>
                <h3 className="font-bold text-slate-900 text-lg mb-4">سلة المشتريات الحالية</h3>
                {cart.length === 0 ? (
                  <p className="text-slate-400 text-sm text-center py-10">السلة فارغة حالياً</p>
                ) : (
                  <div className="space-y-3 max-h-80 overflow-y-auto">
                    {cart.map((item, idx) => (
                      <div key={idx} className="flex justify-between items-center border-b border-slate-100 pb-2">
                        <div>
                          <p className="font-medium text-sm text-slate-900">{item.name}</p>
                          <p className="text-xs text-slate-500">{item.qty} × {item.price} ر.س</p>
                        </div>
                        <span className="font-bold text-sm">{(item.qty * item.price).toFixed(2)} ر.س</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-slate-200 pt-4 mt-4 space-y-4">
                <div className="flex justify-between items-center text-lg font-bold">
                  <span>الإجمالي الكلي:</span>
                  <span className="text-emerald-600">{totalCart.toFixed(2)} ر.س</span>
                </div>
                <button 
                  disabled={cart.length === 0}
                  className="w-full bg-emerald-600 disabled:bg-slate-300 text-white py-3 rounded-xl font-bold hover:bg-emerald-700 transition-colors shadow-lg shadow-emerald-600/20"
                >
                  إتمام الدفع وإصدار الفاتورة الإلكترونية
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'ai' && (
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-6">
            <div className="flex items-center space-x-3 space-x-reverse border-b border-slate-100 pb-4">
              <div className="bg-purple-100 text-purple-600 p-3 rounded-xl">
                <Cpu className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-slate-900">مساعد الذكاء الاصطناعي الصيدلي (Gemini Powered)</h3>
                <p className="text-xs text-slate-500">تحليل التفاعلات الدوائية والتنبؤ باحتياجات المخزون عبر الفروع</p>
              </div>
            </div>

            <div className="bg-slate-50 p-4 rounded-xl space-y-4">
              <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                <p className="text-sm font-semibold text-purple-900">تحليل تلقائي للمخزون:</p>
                <p className="text-sm text-slate-600 mt-1">
                  لاحظ النظام أن دواء "أموكسيسيلين" يرتفع الطلب عليه بنسبة 35% في فرع المروج. يُنصح بتحويل 150 وحدة من الفرع الرئيسي فوراً لتجنب نفاد المخزون.
                </p>
              </div>
              <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm">
                <p className="text-sm font-semibold text-purple-900">تنبيه سلامة دوائية:</p>
                <p className="text-sm text-slate-600 mt-1">
                  تم مطابقة وصفات اليوم بنجاح. لا توجد أي تفاعلات دوائية خطيرة مسجلة في العمليات الأخيرة.
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <input 
                type="text" 
                placeholder="اسأل الذكاء الاصطناعي عن الأدوية، التفاعلات، أو تقارير المخزون..." 
                className="flex-1 px-4 py-3 bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:border-purple-600 text-sm"
              />
              <button className="bg-purple-600 text-white px-6 py-3 rounded-xl font-bold hover:bg-purple-700 transition-colors">
                إرسال الاستعلام
              </button>
            </div>
          </div>
        )}

        {activeTab === 'replication' && (
          <div className="space-y-6">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
              <h3 className="font-bold text-lg text-slate-900 flex items-center space-x-2 space-x-reverse">
                <Server className="w-5 h-5 text-emerald-600" />
                <span>حالة المزامنة والنسخ المتماثل بين الفروع (Replication Gateway)</span>
              </h3>
              <p className="text-sm text-slate-600">
                يعتمد النظام على بروتوكول WebSocket الآمن مع عزل صارم للمستأجرين (`tenantId`) ومنع الحلقات اللانهائية (`originSessionId`).
              </p>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <span className="text-xs font-bold text-emerald-800 block">الفرع الرئيسي - الرياض</span>
                  <span className="text-sm font-semibold text-emerald-900 mt-1 block">متصل (Ping: 12ms)</span>
                  <span className="text-xs text-emerald-600 mt-2 block">آخر مزامنة: منذ ثوانٍ</span>
                </div>
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <span className="text-xs font-bold text-emerald-800 block">فرع المروج</span>
                  <span className="text-sm font-semibold text-emerald-900 mt-1 block">متصل (Ping: 18ms)</span>
                  <span className="text-xs text-emerald-600 mt-2 block">آخر مزامنة: منذ دقيقة</span>
                </div>
                <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-xl">
                  <span className="text-xs font-bold text-emerald-800 block">فرع النزهة</span>
                  <span className="text-sm font-semibold text-emerald-900 mt-1 block">متصل (Ping: 24ms)</span>
                  <span className="text-xs text-emerald-600 mt-2 block">آخر مزامنة: منذ 3 دقائق</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
