# Phase 4 — Competitive Analysis: Roles & Permissions Across Accounting Platforms

**Purpose.** Inform the Orange Way Books multi-user role & permission model with proven patterns from commercial and open-source accounting platforms. Every claim is tied to a source URL; where community/blog posts and official help pages disagree, the official help page is preferred and the discrepancy is noted.

**Research constraint.** This document was compiled via web search summaries. Direct HTML fetches of `quickbooks.intuit.com` help articles and `central.xero.com` articles were blocked in this environment, so a few fine-grained claims (e.g., exact checkbox names inside QBO Advanced Custom Roles) are paraphrased from the snippet text returned by search engines rather than verified by opening the page. Where this happens, it is marked _(paraphrased)_.

---

## 1. Comparison Table

| Platform                                                                                                                                                                                                                                              | Built-in roles                                                                                                                | Custom roles?                                                                                      | Read-only?                                | Time-boxed / auto-expire access?                                                         | Separation of Duties (approver ≠ payer)?                                                                | How new features extend roles |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **QuickBooks Online (Simple Start / Essentials / Plus)** Primary Admin, Company Admin, Standard (All access / Limited — Customers only / Limited — Vendors only / None), Reports Only (Plus only), Time Tracking Only, Take Payments Only, Accountant | No (fixed roles)                                                                                                              | Partial — "Reports Only" is read-only for reports but there is **no true read-only role** for data | No                                        | Limited — payroll approval + bill pay workflows exist in Advanced; not an RBAC construct | Intuit updates built-in roles periodically; existing users keep old permissions unless admin re-assigns |
| **QuickBooks Online Advanced** All of the above **+** Custom Roles                                                                                                                                                                                    | **Yes** — per-area view/create/edit/delete/approve, scoped by location                                                        | Still no true read-only ("Read-only user access isn't available in QBO")                           | No                                        | Yes — custom role can isolate "approve bills" from "pay bills"                           | Admin must edit each custom role to grant access to newly-added areas                                   |
| **Xero (Business)** Subscriber, Advisor, Standard, Read Only, Invoice Only (Draft / Sales / Purchases / Approve & Pay), Payroll Admin (add-on), plus optional toggles: Manage Users, View Reports, View Bank Accounts                                 | No (fixed roles + a few toggles)                                                                                              | Yes (Read Only)                                                                                    | No (deactivation preserves audit trail)   | Partial — payment approval batches, but role model is coarse                             | New features land inside existing roles; Xero chooses which role gets them                              |
| **Xero (Cashbook / Ledger — partner only)** Cashbook Client, Read Only (not on Cashbook), Advisor                                                                                                                                                     | No                                                                                                                            | Yes on Ledger, No on Cashbook                                                                      | No                                        | N/A                                                                                      | Controlled by Xero partner program                                                                      |
| **Wave** Admin, Editor, Viewer, Payroll Manager (+ Block Advisor Tax Pros)                                                                                                                                                                            | No — "Permissions for user roles cannot be customized"                                                                        | Yes (Viewer)                                                                                       | No                                        | No                                                                                       | New features inherit the role's baseline                                                                |
| **Zoho Books** Admin, Staff, Timesheet Staff, Staff (Assigned Customers Only) + Custom Roles                                                                                                                                                          | **Yes** — per-module (Contacts, Items, Banking, Sales, Purchases, Accountant, Timesheet) with view/create/edit/delete/approve | Build via custom role (view only)                                                                  | No                                        | Yes — Approve checkboxes on Sales/Purchases are independent of Create/Edit               | Admin must edit each custom role when new modules added                                                 |
| **FreshBooks** Admin, Manager, Employee, Contractor, Accountant                                                                                                                                                                                       | No — but per-project access toggles                                                                                           | Effectively via Accountant + settings, not a dedicated role                                        | No                                        | No                                                                                       | Manager/Employee access automatically extends; Accountant role curated by FreshBooks                    |
| **Odoo Accounting** Invoicing / Billing, Accountant, Adviser (plus ~generic Internal User / Portal / Public)                                                                                                                                          | **Yes** — groups are composable, new custom groups definable in XML                                                           | Yes — via read-only group or custom group                                                          | No (but audit trail + record rules exist) | Yes — Accountant vs Adviser is explicitly a hierarchy; record rules can gate approval    | `ir.model.access.csv` extends on module install; new groups must be added by developer                  |
| **ERPNext** Accounts User, Accounts Manager, Auditor, plus ~80+ standard roles (HR User, Sales User, Purchase User, Stock User, …), Role Profiles for bundling                                                                                        | **Yes** — per-DocType read/write/create/submit/cancel/amend/delete, per-level (0–9)                                           | Auditor role is read-only by design                                                                | No (permission expiry not built-in)       | Yes — workflow engine + document state permissions                                       | New DocType = must explicitly grant roles; easy to forget                                               |
| **Akaunting** Admin, Manager, Accountant, Employee, Customer (client portal) + Custom Roles                                                                                                                                                           | **Yes** — duplicate and customize any default role                                                                            | Build via custom role                                                                              | No                                        | Via workflow app; not built into role model                                              | Modules register their own permissions; admin must re-edit custom role                                  |

**Sources:**
QuickBooks Online roles — [User roles and access rights (Intuit Help)](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/user-roles-access-rights-quickbooks-online/L66POfRrI_US_en_US); [Add and manage custom roles in QBO Advanced (Intuit Help)](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_US_en_US); [Custom Roles, Fields and Workflows (Intuit marketing)](https://quickbooks.intuit.com/online/advanced/customizations/); [QBO Advanced features](https://quickbooks.intuit.com/accounting/advanced-features/); [Changes to standard roles in QBO (Firm of the Future)](https://www.firmofthefuture.com/product-update/changes-standard-roles-quickbooks-online/); [Can I give my external Accountant read only access? (QBO Community, AU)](https://quickbooks.intuit.com/learn-support/en-au/manage-your-account/can-i-give-my-external-accountant-read-only-access-3f/00/1482928).
Xero — [User roles and permissions in Xero Business edition (Xero Central, GL)](https://central.xero.com/s/article/User-roles-and-permissions-in-Xero-Business-edition-GL); [User roles and permissions in Xero Business edition (US)](https://central.xero.com/s/article/User-roles-and-permissions-in-Xero-Business-edition-US); [Invoice Only user role explained (Xero Central)](https://central.xero.com/s/article/Invoice-Only-user-role); [Read Only user role explained (Xero Central)](https://xero.my.site.com/s/article/Read-Only-role); [Partner plan user roles in client organisations (Xero Central, AU)](https://central.xero.com/s/article/Client-user-roles-AU); [Xero Ledger & Cashbook](https://www.xero.com/us/xero-ledger-and-cashbook/); [User roles in My Xero Partner edition (Xero Central)](https://central.xero.com/s/article/Client-user-roles); Xero Central audit log article cited via [Xero Central question](https://central.xero.com/s/question/0D53m00009MhCEECA3/audit-log-for-the-action-of-removing-user).
Wave — [Understanding user types and permission levels for collaborators (Wave Help)](https://support.waveapps.com/hc/en-us/articles/115000077186-Understanding-user-types-and-permission-levels-for-collaborators); [Invite or remove collaborators (Wave Help)](https://support.waveapps.com/hc/en-us/articles/208621236-Invite-or-remove-collaborators-from-your-business).
Zoho Books — [Users & Roles (Zoho Help)](https://www.zoho.com/us/books/help/settings/users.html); [Create Custom Roles in Zoho Books (Zoho KB)](https://www.zoho.com/us/books/kb/users-and-roles/create-custom-roles.html); [Users and Roles in Transaction Approvals (Zoho Help)](https://www.zoho.com/us/books/help/transaction-approval/users-and-roles.html); [Timesheet User Access Restrictions (Zoho KB)](https://www.zoho.com/us/books/kb/time-tracking/timesheet-staff-access.html).
FreshBooks — [What permissions can I assign to my team member? (FreshBooks Support)](https://support.freshbooks.com/hc/en-us/articles/115002261367-What-permissions-can-I-assign-to-my-team-member); [Team Management (FreshBooks)](https://www.freshbooks.com/team-management); [New Manager Role (FreshBooks Blog)](https://www.freshbooks.com/blog/manager-role).
Odoo — [Odoo Access Rights Structure (VentorTech)](https://ventor.tech/odoo/odoo-access-rights/); [Accounting Groups and Access Rights (Odoo Forum)](https://www.odoo.com/forum/help-1/accounting-groups-and-access-rights-83814); [Odoo 17 Accounting access rights (CandidRoot)](https://www.candidroot.com/blog/our-candidroot-blog-1/how-to-manage-user-access-rights-in-odoo-17-accounting-667); [Accounting and Invoicing — Odoo 17.0 documentation](https://www.odoo.com/documentation/17.0/applications/finance/accounting.html).
ERPNext — [Role and Role Profile (ERPNext Docs)](https://docs.erpnext.com/docs/user/manual/en/role-and-role-profile); [Role Based Permissions (Frappe Docs)](https://docs.frappe.io/erpnext/user/manual/en/users-and-permissions); [manual_erpnext_com Role Based Permissions (GitHub)](https://github.com/frappe/manual_erpnext_com/blob/master/manual_erpnext_com/www/contents/setting-up/users-and-permissions/role-based-permissions.md); [Read permission to Auditor Role (Frappe Discuss)](https://discuss.frappe.io/t/read-permission-to-auditor-role/98845); [Role Permission Manager (Frappe Cloud Marketplace)](https://cloud.frappe.io/marketplace/apps/role_permission_manager).
Akaunting — [Roles and Permission Levels (Akaunting Help)](https://akaunting.com/hc/docs/users-and-roles/roles-and-permission-levels/); [Defining Roles and Permissions (Akaunting Help)](https://akaunting.com/hc/docs/users-and-roles/defining-roles-and-permissions/); [Roles & Permissions app (Akaunting App Store)](https://akaunting.com/apps/roles); [Permissions (Akaunting Developer Docs)](https://akaunting.com/docs/developer-manual/permissions).

---

## 2. Per-Platform Detail

### 2.1 QuickBooks Online (Simple Start / Essentials / Plus / Advanced)

**Built-in roles** ([Intuit Help — User roles and access rights](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/user-roles-access-rights-quickbooks-online/L66POfRrI_US_en_US); [QBExpress guide](https://www.qbexpress.com/a-guide-to-quickbooks-user-types)):

- **Primary Admin** — principal user, every area, owns billing/subscription. Cannot be modified by Company Admin.
- **Company Admin** — same access as Primary Admin except subscription ownership.
- **Standard** (4 subtypes):
  - _All Access_ — full book access except user management & subscription.
  - _Limited — Customers & Sales only_.
  - _Limited — Vendors & Purchases only_.
  - _None_ — can log in, submit timesheets, view own settings (Essentials+ only).
- **Reports Only** _(Plus only — [QBExpress guide](https://www.qbexpress.com/a-guide-to-quickbooks-user-types))_ — read-only across all reports except Audit Log and Payroll. Non-billable.
- **Time Tracking Only** — can only enter own timesheets. Non-billable. Essentials+ only.
- **Take Payments Only** — GoPayment app only, no QBO web access.
- **Accountant** — invited through a separate flow; gets admin-level access plus accountant-specific tools. Typically 2 accountant seats included; no read-only variant.
  - _Note discrepancy:_ several community blog posts imply accountants can be read-only; the official AU community answer explicitly says "the feature to add read-only access to the accountant in QBO is not yet available" ([QBO Community, AU](https://quickbooks.intuit.com/learn-support/en-au/manage-your-account/can-i-give-my-external-accountant-read-only-access-3f/00/1482928)). Treat the community blog claims as outdated.

**Custom Roles (Advanced only)** — this is the big differentiator ([Add and manage custom roles in QBO Advanced](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_US_en_US); [QBO Advanced marketing page](https://quickbooks.intuit.com/online/advanced/customizations/); [Paygration blog](https://paygration.com/user-roles-and-permissions-in-quickbooks-online-advanced-benefits-how-to-use-them/)):

- Permission areas exposed: **Banking, Sales, Expenses, Payroll, Inventory/Stock, Reports, Budgets, Time Tracking, Projects & Tasks, Customers/Vendors, Employees, Checks** _(paraphrased — search snippets, since the live help page could not be retrieved directly)_.
- Per-area actions: **View only, Create, Edit, Delete, Approve, All access** _(paraphrased)_.
- **Location scoping** — you can constrain a custom role to specific locations (e.g., a sales rep can only see their region's invoices). No class scoping.
- **No true read-only role** even in Advanced: "Read-only user access isn't available in QuickBooks Online" (stated in Intuit's own help content per the search snippet for [Add and manage custom roles in QBO Advanced](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_US_en_US)).
- **No time-boxing** — access must be manually revoked.
- **Extensibility gotcha:** "for existing users who have been assigned these roles, the roles will not change unless updated by your company admin" ([Firm of the Future](https://www.firmofthefuture.com/product-update/changes-standard-roles-quickbooks-online/)). When Intuit added new areas historically, admins had to re-edit each custom role.

**Notable design choices:**

- Two-tier admin (Primary vs Company) prevents accidental subscription takeover.
- Billable vs non-billable user distinction for Time Tracking / Reports Only / Take Payments Only — same mechanism we should consider for "contributor" roles that shouldn't consume a seat.
- Custom roles are a **paywall feature** (Advanced-only), which may hint at product-tiering strategy.

---

### 2.2 Xero (Business Edition)

**Built-in roles** ([User roles and permissions in Xero Business edition, GL](https://central.xero.com/s/article/User-roles-and-permissions-in-Xero-Business-edition-GL); [Xero Central — Invoice Only role](https://central.xero.com/s/article/Invoice-Only-user-role); [Xero Central — Read Only role](https://xero.my.site.com/s/article/Read-Only-role); [SaaSant guide](https://www.saasant.com/blog/comprehensive-guide-to-user-roles-and-permissions-in-xero/)):

- **Subscriber** — pays the Xero bill. Only one per org. Can transfer.
- **Advisor** — full access: transactions, chart of accounts, tax, adjustments, lock dates. Intended for external accountants/bookkeepers. Multiple allowed.
- **Standard** — day-to-day employee role. Can enter/edit transactions, reconcile. Cannot access advisor-only tools (journals, conversion date, chart of accounts edits beyond basics).
- **Read Only** — view-only across most data. Excludes inventory, multicurrency, payroll, settings.
- **Invoice Only** — four sub-modes:
  - _Draft only_ — create drafts, cannot approve.
  - _Sales_ — full AR entry/approval.
  - _Purchases_ — full AP entry/approval.
  - _Approve & Pay_ — both plus payment marking.
- **Payroll Admin** — add-on toggle (not a standalone role).
- **Reports toggle** — add-on toggle on Standard/Invoice Only ("View Reports").
- **Bank accounts toggle** — add-on toggle ("View Bank Accounts").
- **Manage Users toggle** — add-on toggle on Advisor/Standard.

**Cashbook / Ledger (partner plans only, [Xero Ledger & Cashbook](https://www.xero.com/us/xero-ledger-and-cashbook/); [Partner plan user roles — AU](https://central.xero.com/s/article/Client-user-roles-AU)):**

- **Cashbook Client** — can reconcile & edit statement lines. No true Read Only option on Cashbook plans.
- **Ledger** — fewer client roles; designed for accountant-driven workflows.

**Notable design choices:**

- **Role + toggles** pattern: a small fixed role set plus a few orthogonal toggles (View Reports, View Bank Accounts, Manage Users, Payroll Admin). This is a hybrid — not pure RBAC, not pure capability flags.
- **No custom roles.** Heavily complained about in Xero Community ([User Roles — greater flexibility idea](https://productideas.xero.com/forums/967121-users-setup/suggestions/44960935-user-roles-ability-to-set-up-greater-flexibility); [User Access — restrict Invoice only to Customer list](https://productideas.xero.com/forums/967121-users-setup/suggestions/45036580-user-access-restrict-invoice-only-role-to-custom)). Common request: let a user reconcile bank but not enter invoices — impossible today.
- **No time-boxed access.** Deactivation preserves audit trail but must be manual ([Xero Central on deactivation vs deletion](https://central.xero.com/s/article/Change-a-user-s-role-or-permissions)).
- **Audit log + History & Notes** per-record. Filter by user. Useful compensating control for the coarse role model.
- **Two-step verification** required for payment approval through Bill Pay integration ([Accountingprose blog on Xero + BILL](https://blog.accountingprose.com/xeros-new-in-app-bill-pay-integration-with-bill)).

---

### 2.3 Wave

**Built-in roles** ([Wave Help — Understanding user types and permission levels](https://support.waveapps.com/hc/en-us/articles/115000077186-Understanding-user-types-and-permission-levels-for-collaborators)):

- **Admin** — full access.
- **Editor** — create/edit transactions. Pro Plan only for invite.
- **Viewer** — read-only. Pro Plan only for invite.
- **Payroll Manager** — payroll-only. Available on all plans.
- **Block Advisor Tax Pro** — special tax-pro-only mode.

**Design:**

- **Hard-coded, no customization** ("Permissions for user roles cannot be customized" — Wave Help).
- **Sensitive pages hidden entirely** — certain pages (e.g., bank connections) are not exposed to invitees regardless of role.
- Admin/Editor/Viewer **behind a paywall** (Pro Plan); Payroll Manager is free. This is an interesting tiering: basic multi-user is paid but sibling workflow roles (payroll) aren't.

---

### 2.4 Zoho Books

**Built-in roles** ([Zoho Help — Users & Roles](https://www.zoho.com/us/books/help/settings/users.html); [Zoho Blog — 3 Ways User Roles Save Trouble](https://www.zoho.com/blog/books/3-ways-user-roles-can-save-you-a-lot-of-trouble.html)):

- **Admin** — org owner, full access.
- **Staff** — all modules except Reports, Settings, Accountant.
- **Timesheet Staff** — timesheet module only ([Zoho KB — Timesheet User Access Restrictions](https://www.zoho.com/us/books/kb/time-tracking/timesheet-staff-access.html)).
- **Staff (Assigned Customers Only)** — scoped to specific customer records.

**Custom Roles** ([Zoho KB — Create Custom Roles](https://www.zoho.com/us/books/kb/users-and-roles/create-custom-roles.html)):

- Permission matrix over **Contacts, Items, Banking, Sales, Purchases, Accountant, Timesheet** modules.
- Per-module flags: **View, Create, Edit, Delete, Approve** (Approve is its own column in Sales/Purchases — explicit separation of duties).
- **Transaction Approvals** feature ([Zoho Help — Users and Roles in Transaction Approvals](https://www.zoho.com/us/books/help/transaction-approval/users-and-roles.html)) uses the role's Approve flag to route submissions through reviewers.

**Design:**

- Closest competitor to what Orange Way Books needs: fixed defaults **+** module-scoped custom roles **+** explicit Approve flag.
- Still no time-boxed access.
- Still no record-level scoping beyond the "Assigned Customers Only" macro-role.

---

### 2.5 FreshBooks

**Built-in roles** ([FreshBooks Support — What permissions can I assign](https://support.freshbooks.com/hc/en-us/articles/115002261367-What-permissions-can-I-assign-to-my-team-member); [FreshBooks blog — Manager Role](https://www.freshbooks.com/blog/manager-role); [FreshBooks Team Management](https://www.freshbooks.com/team-management)):

- **Admin** — full access.
- **Manager** — projects, billing, team management. **Cannot** view financial reports, Accounting tools, or Dashboard.
- **Employee** — project collaboration, own time, own expenses.
- **Contractor** — project collaboration, own dashboard with their own invoices/expenses/estimates.
- **Accountant** — exclusive access to Chart of Accounts, bank reconciliation, journal entries.

**Design:**

- **Very small role set** — reflects FreshBooks' sole-proprietor / small-services target.
- **Per-project access** is a first-class concept orthogonal to role — a Contractor may be on Project A but not Project B.
- **No custom roles, no read-only admin.** Accountant is essentially FreshBooks' answer to "read mostly".
- The Manager role is explicitly described as not seeing financial data — a deliberate "operations head without money access" design.

---

### 2.6 Odoo Accounting

**Built-in groups** ([Odoo 17 docs — Accounting & Invoicing](https://www.odoo.com/documentation/17.0/applications/finance/accounting.html); [Odoo Forum — Accounting Groups](https://www.odoo.com/forum/help-1/accounting-groups-and-access-rights-83814); [CandidRoot — Odoo 17 access rights](https://www.candidroot.com/blog/our-candidroot-blog-1/how-to-manage-user-access-rights-in-odoo-17-accounting-667)):

- **Invoicing / Billing** (`account.group_account_invoice`) — AR/AP entry, payments, statements, limited reports.
- **Accountant** (`account.group_account_user`) — everything the Billing role has, plus full journal entry access, reconciliation, CoA management.
- **Adviser** (`account.group_account_manager`) — includes Accountant plus configuration, tax setup, fiscal year close, lock dates.
- **Internal User** — baseline login; any accounting group layers on top.
- **Portal / Public** — customer/vendor portal access, no internal books.

**Architecture** ([VentorTech — Odoo Access Rights](https://ventor.tech/odoo/odoo-access-rights/); [Cybrosys — Security groups in Odoo 18](https://www.cybrosys.com/blog/how-to-create-security-group-and-manage-access-rights-in-odoo-18); [Serpent Consulting — Users, Groups, Access Rights, Record Rules](https://www.serpentcs.com/serpentcs-security-in-odoo-users-groups-access-rights-record-rules-230)):

- **Layered model**: Groups → Access Rights (per model, read/write/create/unlink) → Record Rules (per-row filter) → Field-level security.
- Access rights live in `ir.model.access.csv` and `security.xml`. Adding a new module ships its own CSV file, automatically extending group permissions on install — **unlike ERPNext, new DocTypes/models get sensible defaults without manual admin intervention.**
- **Record Rules** allow row-level filtering (e.g., "salesperson sees only their own invoices") using domain expressions — this is ABAC layered on RBAC.
- **Custom groups are trivial to create** via XML or UI.

**Design highlights:**

- This is the most powerful model of the 8, at the cost of complexity: groups, inheritance, access rights, and record rules interact in ways that trip up new admins.
- No time-boxed access out of the box; community modules exist.

---

### 2.7 ERPNext

**Built-in roles** relevant to accounting ([ERPNext Docs — Role and Role Profile](https://docs.erpnext.com/docs/user/manual/en/role-and-role-profile); [Frappe Docs — Role Based Permissions](https://docs.frappe.io/erpnext/user/manual/en/users-and-permissions)):

- **Accounts User** — create/edit invoices, payments, journal entries.
- **Accounts Manager** — supervisory, approve/submit/cancel.
- **Auditor** — read-only; must be explicitly granted Read on every DocType the Accounts User can touch ([Frappe Discuss — Read permission to Auditor role](https://discuss.frappe.io/t/read-permission-to-auditor-role/98845)).
- 80+ standard roles exist across modules (HR User, Sales User, Purchase User, Stock User, Item Manager, Leave Approver, …).

**Architecture:**

- **Per-DocType permissions** with actions **Read, Write, Create, Delete, Submit, Cancel, Amend, Print, Email, Report, Import, Export, Share, Set User Permissions**.
- **Permission Levels (0–9)** allow field-level gating on the same DocType: level 0 = base fields, higher levels = restricted fields (e.g., rate on an invoice can be level 1).
- **Role Profiles** bundle multiple roles for quick user assignment.
- **User Permissions** filter records by link field (e.g., user X only sees Company Y).
- **Workflow engine** gates state transitions by role — native separation of duties.

**Design pitfalls** ([Frappe Discuss — Custom role overwrites existing role permissions](https://discuss.frappe.io/t/custom-role-and-and-role-permission-overwrites-existing-role-permissions/95052); [ERPNext issue #47591](https://github.com/frappe/erpnext/issues/47591)):

- **Role explosion** — 80+ default roles is a well-known complaint; the Role Profile abstraction was added to manage it.
- **New DocType = manual permission grant** — forgetting this leaves the Auditor unable to read new DocTypes. The [Role Permission Manager marketplace app](https://cloud.frappe.io/marketplace/apps/role_permission_manager) exists specifically because this is painful.
- No time-boxed access.

---

### 2.8 Akaunting

**Built-in roles** ([Akaunting Help — Roles and Permission Levels](https://akaunting.com/hc/docs/users-and-roles/roles-and-permission-levels/); [Akaunting Help — Defining Roles and Permissions](https://akaunting.com/hc/docs/users-and-roles/defining-roles-and-permissions/)):

- **Admin** — full access.
- **Manager** — business operations (paid plans).
- **Accountant** — cash, bank, reports, invoices/bills, sales, payroll (paid plans).
- **Employee** — limited Admin panel view.
- **Customer** — client portal only; can view own invoices and pay.

**Custom Roles** ([Akaunting Apps — Roles & Permissions](https://akaunting.com/apps/roles); [Akaunting Developer Manual — Permissions](https://akaunting.com/docs/developer-manual/permissions)):

- Defaults cannot be edited, but any default can be **duplicated and customized**.
- Permissions are registered per-module; installed apps extend the permission list.
- Admin must re-edit custom roles when new modules are installed — similar pitfall to ERPNext.

**Design highlights:**

- Client-portal-as-role (Customer role) is a useful pattern for AR portals.
- Roles & Permissions is a **separately-installable app**, meaning multi-user is itself an extension — very modular.

---

## 3. Patterns Worth Adopting

These are patterns that appear across **three or more** platforms and survive the complaint/review scrutiny:

### P1 — Small fixed default set + composable capability flags (Hybrid RBAC)

**Seen in:** Xero (role + toggles), Zoho Books (defaults + custom module matrix), Odoo (groups + record rules), QBO Advanced (standard roles + custom roles).
**Why:** Avoids role explosion (ERPNext problem) while giving power users custom capabilities (QBO Simple Start problem).
**Orange Way Books:** Ship 4–6 named defaults (Owner, Admin, Bookkeeper, Read-Only, Invoice-Only, Time-Tracker). Underneath, everything is composable capability flags so Custom Roles ship "for free".

### P2 — Approve as a first-class capability, distinct from Create/Edit

**Seen in:** Zoho Books (explicit Approve column), QBO Advanced (Approve action), Xero (Invoice-Only has Draft vs Approve&Pay), Odoo (document workflow + record rules), ERPNext (Submit is distinct from Write), Xero+BILL (two-step payment approval).
**Why:** SOX compliance and fraud prevention require separation of duties; the "approve bills" vs "pay bills" split repeatedly appears in real fraud cases ([SafeBooks — SoD for fraud controls](https://safebooks.ai/resources/sox-compliance/segregation-of-duties-for-robust-fraud-controls/); [Numeric — Segregation of Duties](https://www.numeric.io/blog/segregation-of-duties-accounting)).
**Orange Way Books:** Every mutation capability has an optional paired `approve_*` capability. A role can Create without Approve.

### P3 — Non-billable specialized contributor roles

**Seen in:** QBO (Time Tracking Only, Reports Only, Take Payments Only are non-billable), Wave (Payroll Manager and Tax Pros are free/lower-tier).
**Why:** Removes friction for narrow contributors (field staff, accountant collaborators) and avoids seat-padding. Business reason matters: if a user's actions are naturally audited end-to-end (timesheet submit → approve → post), they don't need full seat costs.
**Orange Way Books:** Define a "contributor tier" of roles (time tracker, receipt submitter, reports viewer, external accountant) that are free or cheap to add.

### P4 — Read-only role that actually works

**Seen in:** Xero (Read Only), Wave (Viewer), ERPNext (Auditor), Odoo (read-only groups). **Conspicuously missing in QBO** — a known complaint.
**Why:** Enables auditors, lenders, investors, board members, and M&A diligence without granting edit power. QBO's lack of this is a recurring [user complaint](https://quickbooks.intuit.com/learn-support/en-us/account-management/adding-a-read-only-user/00/1331497).
**Orange Way Books:** Read-Only must be a shipping default in this codebase. Not a toggle, not an upsell.

### P5 — Audit trail per record, filterable by user

**Seen in:** Xero (History & Notes per record + org-level Audit log), QBO (Audit Log excludes Reports-Only users — forensic hardening), Odoo (chatter), ERPNext (Version DocType).
**Why:** Compensating control for any role gaps. Lets forensics happen after the fact even if the role model is coarse.
**Orange Way Books:** Append-only action log keyed by (user_id, entity_id, action, timestamp, delta). Must be visible to Admin/Owner and hidden from the actor themselves.

### P6 — External accountant as a distinct role with its own invite flow

**Seen in:** QBO (Accountant invited separately, firm-level access), Xero (Advisor), Akaunting (Accountant), FreshBooks (Accountant with exclusive tools).
**Why:** External accountants need different onboarding (firm account, multi-client consolidation) and different trust (full access, audit-trail preserved, revocable).
**Orange Way Books:** Ship an "External Accountant" flow that (a) doesn't consume a seat, (b) can be revoked cleanly, (c) preserves audit trail post-revocation, (d) ideally ties to a firm-level account so one accountant manages many Orange Way Books books.

### P7 — Scope by dimension (location/class/customer), not just by role

**Seen in:** QBO Advanced (location scoping on custom roles), Zoho Books (Assigned Customers Only), Odoo (record rules), ERPNext (User Permissions via link field).
**Why:** Multi-location / multi-entity businesses need a sales rep to see only their region, a PM to see only their project. Pure role model forces "Manager East" and "Manager West" — role explosion.
**Orange Way Books:** Support role × dimension. Internally: capability check is `has_capability(user, cap, entity)` where `entity` is resolved against user's scope assignments.

### P8 — Permissions declared by module, automatically merged into defaults on install

**Seen in:** Odoo (CSV per module, composed on install — gold standard), Akaunting (module-level permission registration).
**Why:** Avoids the ERPNext trap where adding Projects or Payroll requires manual re-grant to every custom role. Existing roles should adopt sensible defaults for new capabilities.
**Orange Way Books:** Each feature module ships a `permissions.ts` (or SQL migration) that declares: `default_assignments: { owner: all, admin: all, bookkeeper: read+create, ... }`. Custom roles get a diff view ("New permissions available for your custom role X — apply recommended defaults?") on upgrade.

---

## 4. Mistakes to Avoid

### M1 — QBO's "no true Read-Only"

No read-only role even in Advanced ([QBO Community on read-only accountant, AU](https://quickbooks.intuit.com/learn-support/en-au/manage-your-account/can-i-give-my-external-accountant-read-only-access-3f/00/1482928); [adding a read only user — QBO Community](https://quickbooks.intuit.com/learn-support/en-us/account-management/adding-a-read-only-user/00/1331497); confirmed in the [Intuit help article](https://quickbooks.intuit.com/learn-support/en-us/help-article/access-permissions/add-manage-custom-roles-quickbooks-online-advanced/L8Ugph7xl_US_en_US)). This forces customers to trust accountants with full access or not at all — drives real complaints and compensating controls (separate accounting instances just for auditors).

### M2 — ERPNext's role explosion + manual-grant-on-new-DocType

80+ default roles ([ERPNext Docs](https://docs.erpnext.com/docs/user/manual/en/role-and-role-profile)); new DocTypes need manual permission grants or Auditor goes blind ([Frappe Discuss](https://discuss.frappe.io/t/read-permission-to-auditor-role/98845); [ERPNext issue #47591](https://github.com/frappe/erpnext/issues/47591)). The marketplace app [Role Permission Manager](https://cloud.frappe.io/marketplace/apps/role_permission_manager) exists because of this pain.

### M3 — Xero's role rigidity

No custom roles, Invoice Only cannot be scoped to customer list, can't reconcile bank without invoice creation ability — [top-voted Xero product ideas for years](https://productideas.xero.com/forums/967121-users-setup/category/524051/filters/top?page=4&status_id=5361144). Workaround advice in the wild: "use an intermediate role and audit log regularly" — classic compensating-control tell that the model is too coarse.

### M4 — Wave's zero customization

Cannot customize any permission ([Wave Help](https://support.waveapps.com/hc/en-us/articles/115000077186-Understanding-user-types-and-permission-levels-for-collaborators)); this is fine for a free tier target but a business of 20+ immediately outgrows it. Don't ship this as the only tier if you want mid-market.

### M5 — No time-boxed access across any platform surveyed

None of the 8 ships built-in automatic-expiry access (e.g., "Accountant X has access until 2026-05-15 for tax prep, auto-revoked after"). This is a greenfield opportunity — and a compliance-sensitive customer's common ask for external auditors. Opportunity, not just a mistake-to-avoid.

### M6 — Admin-level accountant access with no read-only option (QBO Accountant)

When the external accountant is always admin-level, revoking access still leaves a trust-window exposure. The common mitigation — create a dedicated low-privilege "audit user" account — shows the primitive is missing.

### M7 — Silent feature-expansion that skips existing custom roles (QBO's pattern)

"For existing users who have been assigned these roles, the roles will not change unless updated by your company admin" ([Firm of the Future](https://www.firmofthefuture.com/product-update/changes-standard-roles-quickbooks-online/)). Users think they have Reports access; they don't. Solve this with explicit upgrade prompts or staged rollout, not silent skip.

### M8 — Hiding sensitive pages entirely instead of role-gating them (Wave)

Wave hides some pages from collaborators "for security reasons" regardless of role. This is inflexible and causes workflow dead-ends. Always prefer explicit role-based gating over hardcoded hiding.

---

## 5. Implications for Orange Way Books

1. **Build capability-flag-first, defaults-layered-on-top.** We get Xero-style simplicity ("pick Admin" covers 90% of users) and QBO Advanced / Zoho custom-role power (edit capabilities per role, scope by dimension) from one engine.
2. **Ship a proper Read-Only role at launch.** Don't make it an upsell. This is free table stakes and removes a recurring complaint from all three commercial competitors.
3. **First-class time-boxed external accountant access** is a genuine market differentiator — no competitor surveyed ships it.
4. **Module permission declarations** must be authored by each feature team, so that adding Invoicing / Inventory / Payroll auto-extends existing defaults _and_ surfaces an "apply recommended defaults?" prompt for custom roles.
5. **Approve capability** must be first-class and separable from Create/Edit, from day one.
6. **Audit log + per-record history** are not optional — they are the compensating control that makes a coarse role assignment safe.

See [`OWB-MULTIUSER-DESIGN.md`](./OWB-MULTIUSER-DESIGN.md) for the proposed capability list and default role composition.
