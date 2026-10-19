import { db } from '@/core/db';
import { CurrencyService } from '@/services/localization/CurrencyService';
import { PrintTemplateEngine } from '@/services/integrity/shared/templateEngineService';
import { authService } from '@features/auth/services/authService';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';

/**
 * Export Service - محرك الطباعة والتصدير الموحد المطور (Unified Template Engine)
 */
export const ExportService = {
  /**
   * تصدير البيانات إلى ملف CSV
   */
  exportToCSV: async (data: any[], filename: string) => {
    if (!data || data.length === 0) return;
    
    const headers = Object.keys(data[0]);
    const BOM = '\uFEFF';
    const csvContent = [
      headers.join(','),
      ...data.map(row => headers.map(header => {
        const val = row[header] !== undefined ? row[header] : '';
        return `"${String(val).replace(/"/g, '""')}"`;
      }).join(','))
    ].join('\n');

    const blob = new Blob([BOM + csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    
    link.setAttribute('href', url);
    link.setAttribute('download', `${filename}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    db.addAuditLog('SYSTEM', 'OTHER', filename, "تم تصدير البيانات بصيغة جدولية (CSV)");
  },

  /**
   * تصدير جداول البيانات بصيغة Excel XML Spreadsheet الرسمية المتوافقة مع Microsoft Excel و Google Sheets
   */
  exportToExcel: function(items: any[], fileName: string, customHeaders?: string[]) {
    if (!items || items.length === 0) return;

    const headers = customHeaders || Object.keys(items[0]);
    
    // Generate XML-based Microsoft Excel 2003 Spreadsheet (.xls) with RTL support and UTF-8 encoding
    const escapeXml = (unsafe: any) => {
      if (unsafe === null || unsafe === undefined) return '';
      return String(unsafe)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    };

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center" ss:ReadingOrder="RightToLeft"/>
   <Font ss:FontName="Segoe UI" ss:Size="11" ss:Color="#1E293B"/>
  </Style>
  <Style ss:ID="Header">
   <Alignment ss:Horizontal="Center" ss:Vertical="Center"/>
   <Borders>
    <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#0F766E"/>
   </Borders>
   <Font ss:FontName="Segoe UI" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#1E4D4D" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="RowEven">
   <Alignment ss:Vertical="Center"/>
   <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="RowOdd">
   <Alignment ss:Vertical="Center"/>
   <Interior ss:Color="#FFFFFF" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="NumberCell">
   <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
   <NumberFormat ss:Format="#,##0.00"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="${escapeXml(fileName.substring(0, 31))}">
  <Table ss:DefaultRowHeight="22" ss:DefaultColumnWidth="120">
   <Row ss:Height="26">
    ${headers.map(h => `<Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('\n    ')}
   </Row>
`;

    items.forEach((item, index) => {
      const styleId = index % 2 === 0 ? 'RowOdd' : 'RowEven';
      xml += `   <Row ss:Height="20">\n`;
      headers.forEach(h => {
        const val = item[h] !== undefined ? item[h] : '';
        const isNum = typeof val === 'number';
        xml += `    <Cell ss:StyleID="${styleId}"><Data ss:Type="${isNum ? 'Number' : 'String'}">${escapeXml(val)}</Data></Cell>\n`;
      });
      xml += `   </Row>\n`;
    });

    xml += `  </Table>
 </Worksheet>
</Workbook>`;

    const blob = new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${fileName}.xls`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    db.addAuditLog('SYSTEM', 'OTHER', fileName, "تم تصدير تقرير بصيغة Excel (XLS/Spreadsheet)");
  },

  /**
   * Export to PDF
   */
  exportToPDFFile: async (title: string, columns: string[], rows: any[][], filename: string) => {
    const doc = new jsPDF({ orientation: 'landscape' }) as any;
    
    // Add title
    doc.setFontSize(18);
    doc.text(title, 14, 22);
    
    // Add timestamp
    doc.setFontSize(10);
    doc.text(`Generated on: ${new Date().toLocaleString('ar-EG')}`, 14, 30);

    autoTable(doc, {
      head: [columns],
      body: rows,
      startY: 35,
      styles: { font: 'helvetica', halign: 'right' },
      headStyles: { fillColor: [30, 77, 77], textColor: 255 },
      alternateRowStyles: { fillColor: [248, 250, 250] }
    });

    doc.save(`${filename}.pdf`);
  },

  /**
   * محرك الرندرة الموحد المعتمد على القوالب (Smart Template Renderer) - للطباعة بدون أخطاء بيضاء
   */
  exportToPDF: async (data: any, type: 'SALE' | 'PURCHASE' | 'VOUCHER' | 'REPORT') => {
    const activeTemplate = await PrintTemplateEngine.getActiveTemplate(type);
    const layoutConfig = JSON.parse(activeTemplate.TemplateLayoutJSON || '{}');
    
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('يرجى السماح بالنوافذ المنبثقة (Popups) لطباعة المستند.');
      return;
    }

    const invoiceConfig = await db.getSetting('invoice_config', {
      pharmacyName: 'PharmaFlow',
      address: 'الموقع غير محدد',
      phone: '-',
      taxNumber: '-',
      footerNote: 'شكراً لتعاملكم معنا'
    });

    const refId = data.SaleID || data.invoiceId || data.purchase_id || data.id || 'N/A';
    const date = new Date(data.date || data.Date || Date.now()).toLocaleDateString('ar-SA');
    const total = data.finalTotal || data.totalAmount || data.amount || 0;
    const currency = data.currency || CurrencyService.getCurrentCurrencyCode();
    const user = authService.getCurrentUser();

    let contentHtml = '';

    if (type === 'REPORT') {
      contentHtml = `
        <div style="margin-bottom: 2rem;">
          <h2 style="font-size: 18px; font-weight: 900; border-bottom: 2px solid ${layoutConfig.primaryColor || '#1E4D4D'}; padding-bottom: 8px; margin-bottom: 16px; color: ${layoutConfig.primaryColor || '#1E4D4D'}">تقرير إحصائي: ${data.reportName || 'عام'}</h2>
          <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px;">
             ${(data.summary || []).map((s: any) => `
               <div style="padding: 16px; background: #f8fafa; border-radius: 12px; border: 1px solid #edf2f2;">
                  <p style="font-size: 10px; font-weight: bold; opacity: 0.5; text-transform: uppercase; margin: 0 0 4px 0;">${s.label}</p>
                  <p style="font-size: 16px; font-weight: 900; margin: 0; color: #1e293b;">${s.value}</p>
               </div>
             `).join('')}
          </div>
        </div>
        <table style="width: 100%; text-align: right; border-collapse: collapse; margin-top: 16px;">
          <thead>
            <tr style="background-color: #f1f5f5; border-bottom: 2px solid #cbd5e1;">
               ${(data.headers || []).map((h: string) => `<th style="padding: 12px 8px; font-size: 12px; font-weight: 900; color: #334155;">${h}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${(data.rows || []).map((row: any, idx: number) => `
              <tr style="border-bottom: 1px solid #f1f5f5; background-color: ${idx % 2 === 0 ? '#ffffff' : '#fafcfc'};">
                ${(data.headers || []).map((h: string) => {
                  const keyIndex = data.headers.indexOf(h);
                  const fallbackKey = Object.keys(row)[keyIndex];
                  const fallbackVal = fallbackKey !== undefined ? row[fallbackKey] : '';
                  return `<td style="padding: 12px 8px; font-size: 12px; font-weight: 700; color: #1e293b;">${row[h] || fallbackVal || ''}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
        </table>
      `;
    } else {
      contentHtml = `
        <div style="display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin-bottom: 24px; background: #f8fafa; padding: 16px; border-radius: 16px;">
           <div>
              <p style="font-size: 9px; font-weight: 900; opacity: 0.4; text-transform: uppercase; margin: 0;">الطرف الثاني / العميل</p>
              <p style="font-size: 14px; font-weight: 900; margin: 4px 0 0 0;">${data.customerId || data.partnerName || data.name || 'عميل نقدي'}</p>
           </div>
           <div style="text-align: left;">
              <p style="font-size: 9px; font-weight: 900; opacity: 0.4; text-transform: uppercase; margin: 0;">الرقم الضريبي</p>
              <p style="font-size: 14px; font-weight: 900; margin: 4px 0 0 0;">${invoiceConfig.taxNumber}</p>
           </div>
        </div>

        <table style="width: 100%; text-align: right; border-collapse: collapse; margin-bottom: 32px;">
          <thead>
            <tr style="border-bottom: 2px solid ${layoutConfig.primaryColor || '#1E4D4D'};">
              <th style="padding: 10px 4px; font-size: 12px; font-weight: 900;">الصنف / البيان</th>
              <th style="padding: 10px 4px; text-align: center; font-size: 12px; font-weight: 900;">الكمية</th>
              <th style="padding: 10px 4px; text-align: left; font-size: 12px; font-weight: 900;">المجموع</th>
            </tr>
          </thead>
          <tbody>
            ${(data.items || []).map((it: any) => `
              <tr style="border-bottom: 1px solid #f8fafa;">
                <td style="padding: 12px 4px; font-size: 12px; font-weight: 700;">${it.name}</td>
                <td style="padding: 12px 4px; text-align: center; font-size: 12px; font-weight: 700;">${it.qty}</td>
                <td style="padding: 12px 4px; text-align: left; font-size: 12px; font-weight: 900;">${it.sum.toLocaleString()}</td>
              </tr>
            `).join('')}
            ${type === 'VOUCHER' ? `<tr><td colspan="3" style="padding: 24px; text-align: center; font-weight: bold; border: 2px dashed #e2e8f0; border-radius: 12px; margin-top: 16px;">${data.notes || 'لا توجد ملاحظات'}</td></tr>` : ''}
          </tbody>
        </table>

        <div style="display: flex; justify-content: flex-end; padding-top: 16px; border-top: 4px double #e2e8f0;">
          <div style="text-align: left;">
            <p style="font-size: 10px; font-weight: 900; opacity: 0.4; text-transform: uppercase; margin: 0;">الإجمالي النهائي المستحق</p>
            <p style="font-size: 24px; font-weight: 900; color: ${layoutConfig.primaryColor || '#1E4D4D'}; margin: 4px 0 0 0;">${total.toLocaleString()} <span style="font-size: 12px;">${currency}</span></p>
          </div>
        </div>
      `;
    }

    const html = `
      <!DOCTYPE html>
      <html dir="${activeTemplate.RTL_Support ? 'rtl' : 'ltr'}" lang="ar">
        <head>
          <meta charset="UTF-8">
          <title>${activeTemplate.TemplateName}_${refId}</title>
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Cairo:wght@400;700;900&display=swap');
            body { font-family: 'Cairo', sans-serif; padding: 30px; background: #ffffff; color: #1e293b; margin: 0; direction: rtl; }
            .print-container { max-width: 700px; margin: 0 auto; border: 1px solid #e2e8f0; padding: 32px; border-radius: 24px; background: #ffffff; }
            .no-print { display: flex; gap: 12px; justify-content: center; margin-top: 30px; }
            button { padding: 12px 28px; border-radius: 14px; font-weight: 900; font-family: 'Cairo', sans-serif; cursor: pointer; border: none; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
            @media print { 
              .no-print { display: none !important; } 
              body { padding: 0 !important; background: white !important; }
              .print-container { border: none !important; box-shadow: none !important; padding: 0 !important; max-width: 100% !important; }
            }
          </style>
        </head>
        <body>
          <div class="print-container">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24px; border-bottom: 2px solid ${layoutConfig.primaryColor || '#1E4D4D'}; padding-bottom: 16px;">
              <div>
                <h1 style="font-size: 20px; font-weight: 900; color: ${layoutConfig.primaryColor || '#1E4D4D'}; margin: 0 0 4px 0;">${invoiceConfig.pharmacyName}</h1>
                <p style="font-size: 10px; font-weight: bold; opacity: 0.6; margin: 0 0 2px 0;">${invoiceConfig.address}</p>
                <p style="font-size: 10px; font-weight: bold; opacity: 0.6; margin: 0;">هاتف: ${invoiceConfig.phone}</p>
              </div>
              <div style="text-align: left;">
                <h2 style="font-size: 16px; font-weight: 900; margin: 0 0 4px 0; text-transform: uppercase;">${
                  type === 'SALE' ? 'فاتورة مبيعات' : 
                  type === 'PURCHASE' ? 'فاتورة مشتريات' : 
                  type === 'VOUCHER' ? 'سند مالي' : 'تقرير نظام'
                }</h2>
                <p style="font-size: 12px; font-weight: 900; margin: 0 0 2px 0;">#${refId}</p>
                <p style="font-size: 10px; font-weight: bold; opacity: 0.6; margin: 0;">${date}</p>
              </div>
            </div>

            ${contentHtml}

            <div style="margin-top: 40px; padding-top: 16px; border-top: 1px solid #f1f5f5; text-align: center;">
               <p style="font-size: 10px; font-weight: bold; color: #94a3b8; font-style: italic; margin: 0 0 8px 0;">${invoiceConfig.footerNote}</p>
               <div style="opacity: 0.4; font-size: 8px; font-weight: 900; text-transform: uppercase;">Printed by: ${user?.User_Name || 'Unknown'} | Template: ${activeTemplate.TemplateName}</div>
            </div>
          </div>
          
          <div class="no-print">
             <button onclick="window.print()" style="background: #1E4D4D; color: white;">طباعة المستند 🖨️</button>
             <button onclick="window.close()" style="background: #f1f5f5; color: #64748b; border: 1px solid #e2e8f0;">إغلاق</button>
          </div>

          <script>
            window.onload = function() {
              setTimeout(() => {
                // Ensure layout and fonts are fully rendered
              }, 300);
            };
          </script>
        </body>
      </html>
    `;

    printWindow.document.open();
    printWindow.document.write(html);
    printWindow.document.close();

    db.addAuditLog(
      'SYSTEM', 
      type === 'REPORT' ? 'OTHER' : type as any, 
      refId, 
      `تم طباعة مستند [${type}] باستخدام قالب [${activeTemplate.TemplateName}] بصيغة PDF/PRINT`
    );
  }
};
