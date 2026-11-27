# Phase 4C-3C — Historical Invoice Persistence & Sync Path Verification

**التاريخ:** 2026-11-10  
**نوع العمل:** Read-only code audit + remediation plan  
**الحالة المرجعية:** `main` عند `d8db0faccc5c6452f433114bf457c7c1147f5e68`  
**نطاق التغيير في هذا الفرع:** هذا التقرير فقط. لا يوجد تعديل على كود الإنتاج أو المخطط أو البيانات.

## 1. Executive verdict

**النتيجة: FAIL — مسار ترحيل فاتورة البيع غير موثوق حالياً.**

تم إثبات عيبين مستقلين في الكود الحالي:

1. فشل `DistributedSyncEngine.enqueue()` يمكن ابتلاعه بعد نجاح معاملة البيع المحلية؛ ويُعاد للمستدعي نجاح مع `syncStatus: ENQUEUED` رغم عدم ثبوت وجود Queue record.
2. حتى إذا نجح الإدخال المحلي ووصلت الحمولة الحالية إلى الخادم، فإن شكلها لا يطابق عقد `AtomicPostSaleService` و`InvoiceSchema`؛ والمسار الحالي سيرفضها عند التحقق.

**لكن لا يوجد دليل كافٍ للقول إن الفاتورتين التاريخيتين حاولتا enqueue بالفعل أو أن طلباً خرج إلى الشبكة.** تقرير Dexie يثبت عدم العثور على سجلات مزامنة مرتبطة بهما بالمراجع الدقيقة التي يفحصها، ولا يثبت سبب غيابها أو عدم وجود سجلات غير مرتبطة.

## 2. Evidence baseline and scope

تمت مراجعة الملفات من GitHub `main` عند commit أعلاه، وليس من ZIP المرفوع؛ فالـZIP أقدم ولا يمثل هذه الحالة.

الملفات الأساسية التي تمت مراجعتها:

- `src/core/workflow/workflowExecution.ts`
- `src/core/integrity/transactionBoundary.ts`
- `src/features/sales/workflows/SalesWorkflow.ts`
- `src/features/sync/sync.engine.ts`
- `src/features/sync/sync.types.ts`
- `src/features/sync/device.manager.ts`
- `src/features/inventory/utils/localSyncQueueForensics.ts`
- `server/modules/sync/sync.router.ts`
- `server/modules/sync/sync-processor.service.ts`
- `server/modules/accounting/services/atomicPostSale.service.ts`
- `server/modules/accounting/services/financialTransaction.service.ts`
- `src/shared/validation/invoice.schema.ts`

لم يتم الاتصال بقاعدة Supabase أو قراءة بيانات Production، ولم يتم تشغيل أو إعادة إرسال أي Mutation، ولم تُنفذ اختبارات أو تعديلات على كود الإنتاج ضمن هذا التدقيق.

## 3. Findings

### F-01 — enqueue failure is swallowed after the sale transaction commits

**Severity: P1 — Critical reliability / data consistency**  
**Confidence: Confirmed from source**

في `WorkflowExecutionPipeline.run()`:

- تنفذ `workflow.executeDomainSteps()` داخل `TransactionBoundary.executeAtomic()`.
- تنتهي معاملة Dexie وتُعتمد نتائج البيع محلياً.
- يتم تحديث سجل Idempotency إلى `COMMITTED`.
- بعد ذلك فقط يستدعي الـPipeline `DistributedSyncEngine.enqueue()`، أي خارج معاملة البيع.
- كتلة `catch(syncErr)` تسجل `console.warn` فقط ولا تعيد الخطأ.
- يستمر التنفيذ إلى `WorkflowResultBuilder.success(... syncStatus: 'ENQUEUED')`.

وبالتالي يمكن أن تُحفظ الفاتورة والمخزون والقيود محلياً، ثم يفشل Queue insertion، ومع ذلك يتلقى المستدعي نجاحاً وحالة `ENQUEUED`.

**الأثر:** لا توجد ذرية بين اعتماد العملية المالية وإدخال Outbox/Queue. وقد تصبح الفاتورة محلية فقط دون تنبيه موثوق.

### F-02 — idempotent replay can permanently bypass the missing enqueue

**Severity: P1**  
**Confidence: Confirmed from source**

في بداية `WorkflowExecutionPipeline.run()`، إذا وجد `IdempotencyRegistry` سجلاً بحالة `COMMITTED` وبيانات نتيجة، يعيد الـPipeline النتيجة فوراً قبل تنفيذ Domain Steps أو استدعاء enqueue.

إذا وقع السيناريو التالي:

1. معاملة البيع المحلية نجحت.
2. تم حفظ `COMMITTED`.
3. فشل enqueue وتم ابتلاع الخطأ.

فإن إعادة المحاولة بالمفتاح نفسه قد تعيد نتيجة البيع المخزنة دون إعادة محاولة enqueue. كما أن `WorkflowResultBuilder.success()` يضع افتراضياً `syncStatus: ENQUEUED` ما لم يُمرر غير ذلك؛ لذلك قد تعرض إعادة التشغيل حالة ENQUEUED رغم عدم وجود دليل Queue.

**الأثر:** retry العادي ليس آلية إصلاح موثوقة للفجوة الحالية.

### F-03 — business transaction and queue/outbox are not one atomic transaction

**Severity: P1**  
**Confidence: Confirmed from source**

`TransactionBoundary.executeAtomic()` ينفذ جداول `workflow.tables` فقط. قائمة `SalesWorkflow.tables` الحالية لا تتضمن `syncQueue` أو `outbox`. ويحدث استدعاء `enqueue()` بعد انتهاء `TransactionBoundary`.

يوجد في `DistributedSyncEngine` مسار `enqueueWithinTransaction()`، لكنه غير مستخدم من `WorkflowExecutionPipeline` الحالي. كما أن هذا المسار يكتب Outbox فقط إذا كان جدول Outbox ضمن معاملة Dexie الحالية؛ وإلا قد يكتب Queue دون Outbox.

**الأثر:** حتى لو عولج ابتلاع الخطأ وحده، سيبقى احتمال انقطاع التطبيق بين اعتماد البيع المحلي وكتابة Queue قائماً.

### F-04 — current client payload does not satisfy the server sale command schema

**Severity: P1 — Guaranteed contract rejection for the current payload shape**  
**Confidence: Confirmed from source composition**

نتيجة `SalesWorkflow.executeDomainSteps()` هي:

```ts
{
  refId,
  sale: savedDoc
}
```

ثم يبني `WorkflowExecutionPipeline` حمولة enqueue على النحو التالي:

```ts
{
  id: domainResult.refId || ctx.workflowId,
  ...domainResult,
  workflowId: ctx.workflowId,
  operationType: workflow.operationType
}
```

بالنسبة إلى `SalesWorkflow`، تصبح الحمولة الفعلية ذات الحقول العليا: `id`, `refId`, `sale`, `workflowId`, `operationType`. بيانات الفاتورة الفعلية موجودة داخل `sale`، وليست في الحقول العليا المطلوبة.

عند الإرسال، يضع `processMutationWithRetry()` هذه الحمولة في `mutation.payload` ويرسل:
- `entity = SALE`
- `operation = POST`

ويحوّل الخادم هذا المسار إلى `AtomicPostSaleService.executePostSaleCommand()`.

لكن `InvoiceSchema` يطلب في المستوى الأعلى:
- `invoiceNumber`
- `type`
- `totalAmount`
- `items`

ويستخدم `.strict()`، لذلك يرفض الحقول الإضافية مثل `id`, `refId`, `sale`, `workflowId`, `operationType`. كما أن `SyncProcessorService` يضيف `tenantId` إلى الحمولة قبل تمريرها إلى `AtomicPostSaleService`، بينما `InvoiceSchema.strict()` لا يعرّف `tenantId` أيضاً.

**النتيجة:** إذا وصلت الحمولة الحالية إلى فرع SALE/POST، فستفشل عند `InvoiceSchema.parse()` قبل إنشاء الفاتورة على الخادم. هذه نتيجة استدلال مباشر من شكل الحمولة ومن الـSchema، وليست نتيجة طلب HTTP حي.

### F-04B — Outbox path changes POST into CREATE

**Severity: P1 — Incorrect persistence path / data integrity**  
**Confidence: Confirmed from source composition**

There are two independent senders in `DistributedSyncEngine.drainQueue()`:

- `processMutationWithRetry()` sends the Queue item's `operationType`; the current sale Queue item carries `POST`.
- `processOutboxEvent()` sends `operation: event.operation || 'CREATE'`.

However, `enqueue()` constructs the Outbox record with a `type` property, not an `operation` property. Therefore, the Outbox sender does not read the stored `type: 'POST'` and defaults to `CREATE`.

For `entityType: 'SALE'`, the server's `SALE/CREATE` path bypasses the atomic sale-posting branch and falls through to generic `buildEntityCreateData()`. The current nested payload lacks the expected top-level invoice fields; the generic builder then applies defaults (including a generated invoice number, empty partner ID, PAID status and zero total) and does not create invoice items. Depending on database constraints, this may fail or create an incomplete invoice record; neither outcome represents a valid posted sale.

Because the drain loop processes Queue and Outbox independently, a failed Queue POST does not itself prevent the Outbox event from being attempted afterward.

**Impact:** Queue and Outbox do not currently preserve identical operation semantics. A fix must make both records carry one canonical operation field and ensure duplicate delivery is idempotent across both senders. Prefer a single authoritative dispatch path unless dual delivery is proven necessary.

### F-05 — server POST handler is a financial posting command, not a passive historical import

**Severity: P0 for unsafe replay / financial duplication risk**  
**Confidence: Confirmed from source**

`AtomicPostSaleService` لا يقوم بمجرد حفظ Snapshot تاريخي:

1. يتحقق من الحمولة والسعر والإجمالي.
2. ينشئ Invoice جديدة في Prisma.
3. يستدعي `FinancialTransactionService.executeInvoiceLedgerPosting()`.
4. يجمع آثار الفاتورة والقيد وحركات المخزون.

و`executeInvoiceLedgerPosting()` يستدعي `FifoService.depleteStock()` لكل بند بيع، ثم ينشئ أثر COGS/المخزون والقيود المحاسبية. كما أن إنشاء الفاتورة لا يمرر معرّف الفاتورة المحلي إلى `tx.invoice.create`؛ ويعتمد فحص التكرار الظاهر هنا على `invoiceNumber + tenantId`.

**الأثر:** لا يجوز إرسال فاتورة محلية POSTED تاريخية عبر هذا المسار كأنها Mutation جديدة دون إثبات أن ذلك لن يعيد صرف المخزون أو ترحيل القيود. ويزداد الخطر لأن تقرير FIFO الحالي لم يجد أدلة FIFO للفاتورتين.

### F-06 — server calculation contract is not aligned with local pricing fields

**Severity: P1 — Financial correctness**  
**Confidence: Confirmed mismatch in visible implementation**

يقوم `SalesWorkflow` بحساب الإجمالي محلياً باستخدام `LocalSalesPricingService`، ويملأ حقول الخصم والضريبة والإيراد. أما `AtomicPostSaleService` فيعيد حساب `calculatedTotal` من `qty × serverPrice` فقط، ثم يقارنه بـ`validated.totalAmount`. لا يظهر في هذا الحساب تطبيق `discountPercent` أو ضريبة البيع.

كما أن الخدمة تجلب `basePrice || price` من الخادم، بينما التحقق المحلي في `SalesWorkflow` يعتمد على `product.price`. وقد تختلف القيمتان. وحقول الضريبة/المجموع الفرعي/الخصم التفصيلية غير معرفة في `InvoiceSchema` الحالي ذي `.strict()`.

**الأثر:** حتى بعد تسطيح الحمولة، قد تُرفض فواتير الخصم أو الضريبة أو تختلف عن سياسة السعر المحلية. لا يجوز حل ذلك بتخفيف التحقق أو قبول الإجمالي المرسل من العميل؛ يجب توحيد سياسة الحساب وإعادة الحساب باستخدام Decimal واختبارات مطابقة.

### F-07 — interpretation of the forensic report's ownership field was incorrect

**Severity: P2 — Forensic report semantics**  
**Confidence: Confirmed from forensic utility**

يجب تصحيح تفسير `ownership: UNVERIFIABLE` في التقرير الذي أرسله المستخدم:

- يقوم `buildLocalSyncForensics()` بإضافة الفاتورة إلى `activeInvoices` فقط إذا كانت قيمة `tenantId` أو `tenant_id` تساوي تماماً `session.tenantId`.
- لذلك، فإن الفاتورتين اللتين ظهرتا في `invoiceCount: 2` اجتازتا بالفعل شرط تطابق المستأجر النشط وقت الفحص.
- لكن حقل `ownership` في Finding لا يقيس ملكية الفاتورة نفسها؛ بل يحسب ملكية سجلات المزامنة المرتبطة بها.
- عندما لا توجد سجلات مرتبطة، تكون قائمة `ownerStates` فارغة، فيرجع الكود `UNVERIFIABLE`.

**التصحيح:** التقرير يدعم أن الفاتورتين تحملان `tenantId` مطابقاً للمستأجر النشط وقت الفحص (أو الاسم البديل `tenant_id`). أما `UNVERIFIABLE` فيعني عدم وجود سجل مزامنة مرتبط يمكن تقييم ملكيته، وليس دليلاً على أن `tenantId` الفاتورتين مفقود أو خاطئ. لا يكشف التقرير القيمة الفعلية للمعرف، وهذا مناسب للخصوصية.

### F-08 — forensic counts are linked-record counts, not global store counts

**Severity: P2 — Evidence limitation**  
**Confidence: Confirmed from forensic utility**

تقرأ أداة الفحص مخازن Queue/Outbox، لكنها تضيف السجل إلى نتائج الفاتورة فقط عند العثور على مرجع مستند دقيق عبر `documentRefs()` يطابق أحد معرفات الفاتورة/البدائل. لا تستخدم رقم الفاتورة أو العميل أو المنتج.

لذلك فإن `syncQueueCount: 0` و`outboxCount: 0` تعني عدم العثور على سجلات مرتبطة بهذه الفواتير بالمراجع التي تدعمها الأداة. ولا تعني بالضرورة أن المخازن فارغة عالمياً أو أنه لا توجد سجلات orphan/unlinked. كما لا تعرض المخرجات الحالية إجمالي سجلات المخازن غير المرتبطة.

**الأثر:** لا يجوز تحويل النتيجة إلى ادعاء قطعي بأن enqueue لم يُستدعَ أو أن كل صفوف Queue غير موجودة.

## 4. Exact enqueue failure scenarios

هذه سيناريوهات مدعومة بالكود أو بخصائص IndexedDB؛ لا يوجد دليل يحدد أيّاً منها وقع مع الفاتورتين:

| السيناريو | سلوك `enqueue()` الحالي | هل ثبت وقوعه تاريخياً؟ |
|---|---|---|
| غياب جلسة مصادقة موثوقة أو Token/User ID | يرمي `TRUSTED_USER_CONTEXT_REQUIRED` | لا |
| اختلاف Tenant بين خيارات العملية والجلسة | يرمي `TRUSTED_TENANT_CONTEXT_MISMATCH` | لا |
| غياب Branch صالح أو استخدام قيمة محظورة | يرمي `TRUSTED_BRANCH_CONTEXT_REQUIRED` | لا |
| فشل توليد Mutation ID بسبب عدم توفر `crypto` ككائن | قد يرمي قبل بدء Dexie transaction؛ الوصول إلى `crypto.randomUUID` غير محمي بـ`typeof crypto` | لا |
| فشل الحصول على Device Identity | قد يفشل بناء سجل Queue قبل الكتابة؛ معظم أخطاء localStorage/configuration تُلتقط داخلياً، لذلك لا يصح افتراض أنها السبب | لا |
| IndexedDB quota/storage exhaustion أو transaction abort/database closure | قد يفشل `add()` أو commit ويرفض Promise | لا |
| ConstraintError بسبب idempotency unique index | يحاول الكود إعادة استخدام سجل موجود، لكنه يرمي إذا لم يجد زوج Queue/Outbox صالحاً ومتطابق الملكية | لا |
| تعارض Queue/Outbox أو اختلاف Mutation IDs/المالك | `resolveExistingIdempotency()` يرفض الإصلاح التلقائي ويرمي | لا |
| Outbox add يفشل بعد Queue add | في `enqueue()` يتم الإدخال داخل Dexie transaction مشتركة؛ يفترض أن تتراجع الكتابتان مع فشل المعاملة | لا |
| عدم وجود SyncQueue schema/table أو عدم توافق نسخة قاعدة البيانات | قد يفشل الوصول للجدول أو الكتابة | لا؛ المخزن ظهر في الفحص الحالي |

ملاحظة: `DeviceManager` يلتقط أخطاء localStorage عند القراءة/الكتابة ويستخدم ذاكرة مؤقتة؛ لذلك امتلاء localStorage وحده ليس تفسيراً مثبتاً لفشل Queue. أما امتلاء مساحة IndexedDB فهو سيناريو مختلف يمكن أن يسبب فشل الكتابة.

كما أن `enqueue()` يلتقط ConstraintError فقط لمحاولة idempotent reconciliation؛ بقية الأخطاء تُعاد من الدالة، ثم يبتلعها حالياً `WorkflowExecutionPipeline`.

## 5. Historical invoices: what is verified

المتاح من التقريرين:

- فاتورتان POSTED ضمن نطاق المستأجر النشط.
- تقرير FIFO: لا توجد طبقات `inventory_layers` ولا سجلات `fifo_consumption_log` في نطاق البيانات المفحوص؛ وكلتا الفاتورتين Category C.
- تقرير Sync Queue: لا توجد سجلات مرتبطة بالفاتورتين بالمراجع الدقيقة التي تدعمها أداة الفحص.
- فحص الملكية في أداة Local Sync Forensics يثبت أن الفاتورتين اجتازتا شرط `tenantId === active session tenantId` عند توليد التقرير.

غير المتاح:

- القيم الخام للفاتورتين، ومعرفاتهما، وبنودهما، وقيم `branchId/userId`.
- ما إذا كانت هناك Queue/Outbox rows غير مرتبطة بسبب اختلاف/نقص مرجع المستند.
- سجل runtime يثبت دخول `enqueue()` أو يحدد استثناءه.
- ما إذا كانت هناك نسخ على جهاز آخر أو بيانات على Supabase مرتبطة بهما.

**الحكم:** لا يمكن تحديد سبب فشل enqueue التاريخي لكل فاتورة من التقريرين المنقحين وحدهما. يلزم تصدير محلي Read-only ومقيد بالمستأجر، مع الاحتفاظ بالمعرفات داخلياً في بيئة آمنة، وفحص السجلات غير المرتبطة دون عرضها في التقرير العام.

## 6. Surgical remediation plan — no implementation in this PR

### Phase A — Make local business commit and queue commit atomic

1. تضمين `syncQueue` و`outbox` صراحة في جدول المعاملة الخاصة بـSalesWorkflow.
2. استدعاء `enqueueWithinTransaction()` من داخل callback الخاص بـ`TransactionBoundary.executeAtomic()` بعد تكوين نتيجة البيع، لا بعد انتهاء المعاملة.
3. التأكد أن `outbox` موجود ضمن Dexie transaction الحالية؛ لا تسمح بالنجاح الصامت مع Queue-only إذا كان Outbox مطلوباً في مخطط الإصدار الحالي.
4. إذا فشل إدخال Queue أو Outbox أو التحقق من المالك أو idempotency، يجب أن تفشل معاملة البيع المحلية بأكملها، بحيث لا تبقى فاتورة/حركة مخزون/قيود محلية بلا حدث مزامنة.
5. لا تنفذ أي HTTP request داخل معاملة Dexie. بعد نجاح commit فقط، شغّل `requestSync()` كإشارة غير حاجبة.
6. لا تضع `syncStatus: ENQUEUED` إلا بعد نجاح كتابة Queue/Outbox فعلياً. أعد حالة صريحة في نتيجة workflow عند تعذر ذلك.
7. أصلح مسار Idempotent replay: يجب أن يتحقق من وجود حدث Outbox/Queue durable مرتبط بالمفتاح قبل إرجاع `COMMITTED` كنجاح، وأن يسمح بإعادة بناء الحدث بأمان إذا كانت المعاملة القديمة قد اعتمدت بلا Outbox. لا تنشئ عملية بيع ثانية.

### Phase B — Define one explicit versioned SALE sync DTO

1. لا ترسل `SalesWorkflowResult` كحمولة عامة عبر spread.
2. أنشئ mapper صريحاً من `savedDoc` إلى DTO مسطح ومُصدّر ومُختبر.
3. افصل بيانات المستند عن سياق المصادقة. الخادم يستمد `tenantId/userId` من الجلسة الموثقة؛ لا يمرر `tenantId` كحقل غير معروف إلى Schema صارمة.
4. عرّف حقول المصدر بوضوح، بما فيها `sourceInvoiceId`، ورقم الفاتورة، ونوع المستند، والشريك، والبنود، والعملة، والتاريخ، وحالة الدفع، والخصم والضريبة عند استخدامها.
5. وحّد قواعد الحساب بين LocalSalesPricingService وAtomicPostSaleService: السعر المرجعي، الخصم، الضريبة، والتقريب. استخدم Decimal على الخادم، ولا تثق بإجمالي العميل وحده.
6. اختبر قبول DTO حقيقي ناتج من SalesWorkflow عبر نفس `InvoiceSchema` ونفس مسار `/api/v1/sync/push`، مع اختبارات رفض للحمولات غير الصحيحة.

### Phase C — Separate historical import from new-sale posting

1. لا تعالج الفاتورتين عبر إعادة تشغيل `SALE/POST` الحالي؛ هذا المسار ينفذ FIFO depletion وLedger posting.
2. أضف مسار استيراد تاريخي إداري منفصل، يبدأ بـDry Run فقط، ويتطلب `sourceInvoiceId` ثابتاً ومفتاح idempotency ثابتاً.
3. افحص قبل الكتابة وجود أي Invoice أو Journal أو InventoryMovement أو Idempotency record على الخادم، بالمستأجر الصحيح ومعرف المصدر/رقم الفاتورة، ثم صنّف الحالة: ABSENT / EXACT_MATCH / PARTIAL_MATCH / CONFLICT.
4. تحقق من تطابق المنتجات والعملاء والفرع والكميات والأسعار والعملة والإجماليات والخصومات والضرائب والتواريخ، مع سجل تدقيق لكل قرار.
5. لا تنشئ قيداً أو حركة مخزون ثانية إذا كانت موجودة، ولا تعتبر استيراد Header/Items وحده ترحيلاً مالياً مكتملًا.
6. بما أن FIFO evidence غير متاح حالياً للفواتير، يجب عزل أي فاتورة لا يمكن إعادة بناء تكلفتها ومصدر صرفها بشكل موثوق. لا تخمّن COGS ولا تستخدم تكلفة المنتج الحالية كبديل للتكلفة التاريخية.
7. لا تُعتمد الفاتورة على الخادم كـPOSTED إلا بعد مطابقة كاملة للفاتورة والمخزون ودفتر الأستاذ. خلاف ذلك تبقى في حالة مراجعة/تسوية منفصلة.

### Phase D — Regression and failure-injection gates

قبل دمج أي إصلاح:

- اختبار أن فشل `syncQueue.add` يؤدي إلى Rollback كامل لفاتورة البيع والمخزون والقيود المحلية.
- اختبار أن فشل `outbox.add` يؤدي إلى Rollback للكتابة المزدوجة.
- اختبار QuotaExceededError / AbortError / ConstraintError / session switch / missing tenant / missing branch.
- اختبار أن Idempotent replay لا يعيد البيع ولا يترك العملية بلا Queue.
- اختبار أن DTO الحقيقي من SalesWorkflow يمر عبر `/api/v1/sync/push` ويصل إلى النتيجة المتوقعة.
- اختبار أن الحمولة الحالية القديمة تُرفض برسالة واضحة ولا تُسجل كنجاح.\n- اختبار أن Queue وOutbox لا يرسلان عمليتين مختلفتين لنفس Mutation، وبخاصة منع تحويل POST إلى CREATE.
- اختبارات مالية للخصومات والضرائب والأسعار وCOGS وتوازن القيود وFIFO.
- اختبار duplicate delivery وlost response باستخدام نفس idempotency key، مع منع إنشاء فاتورة أو حركة مخزون أو قيد مكرر.

## 7. Execution order and safety gates

1. **أولاً:** إصلاح الذرية وFail-Closed محلياً، مع اختبارات فشل Dexie وIdempotency.
2. **ثانياً:** تثبيت عقد DTO بين العميل والخادم واختبارات HTTP حقيقية.
3. **ثالثاً:** بناء أداة Dry Run لتسوية الفاتورتين التاريخيتين دون كتابة.
4. **رابعاً:** مراجعة مالية ومخزنية مستقلة لنتيجة Dry Run، ثم طلب موافقة منفصلة قبل أي ترحيل فعلي.

لا يتم في أي مرحلة:
- تعديل بيانات Production أو Supabase دون موافقة منفصلة.
- إعادة إرسال الفاتورتين عبر Sync Queue الحالية.
- إعادة إنشاء FIFO أو COGS بالتخمين.
- إعادة ترحيل قيود أو حركات مخزون قائمة.
- تغيير Schema أو تشغيل Migration ضمن PR التدقيق الحالي.

## 8. Final conclusion

السبب الجذري في التصميم الحالي واضح: **الفصل بين اعتماد البيع المحلي وإدخال Queue، مع ابتلاع خطأ enqueue، ثم وجود عقد حمولة غير متوافق مع معالج POST، واختلاف دلالة العملية بين Queue وOutbox.**

لكن سبب غياب Queue evidence عن الفاتورتين تحديداً ما زال غير مثبت تاريخياً. كما أن `UNVERIFIABLE` في التقرير لا يعني أن TenantId الفاتورتين غير صحيح؛ بل نتج عن عدم وجود سجلات مزامنة مرتبطة لتقييم ملكيتها.

**التوصية:** قبول هذا التقرير كمرحلة تدقيق فقط. لا تبدأ ترحيل الفاتورتين ولا تغيّر منطق FIFO/المحاسبة قبل تنفيذ Phase A وB واختبارهما، ثم بناء Dry Run تاريخي مستقل.
