export interface Employee {
  id: string;
  name: string;
  role: "employee" | "extra" | string;
  casualLeave: { used: number; total: number };
  sickLeave: { used: number; total: number };
  biometricStatus: "enrolled" | "pending" | "none";
  grossSalary: number;
  hoursWorked?: number;
  hourlyRate?: number;
  carryOverAmount?: number;
  status: "active" | "on-leave" | "inactive";
  email?: string;
  phone?: string;
  address?: string;
  identifiers?: { type: string; value: string; amount: number }[];
}

export const employees: Employee[] = [
  { id: "EMP-001", name: "Maria Santos", role: "employee", casualLeave: { used: 3, total: 10 }, sickLeave: { used: 1, total: 10 }, biometricStatus: "enrolled", grossSalary: 85000, status: "active" },
  { id: "EMP-002", name: "Juan Dela Cruz", role: "employee", casualLeave: { used: 5, total: 10 }, sickLeave: { used: 2, total: 10 }, biometricStatus: "enrolled", grossSalary: 65000, status: "active" },
  { id: "EMP-003", name: "Ana Reyes", role: "employee", casualLeave: { used: 2, total: 10 }, sickLeave: { used: 0, total: 10 }, biometricStatus: "enrolled", grossSalary: 55000, status: "active" },
  { id: "EMP-004", name: "Carlos Mendoza", role: "employee", casualLeave: { used: 7, total: 10 }, sickLeave: { used: 4, total: 10 }, biometricStatus: "pending", grossSalary: 72000, status: "active" },
  { id: "EMP-005", name: "Liza Garcia", role: "employee", casualLeave: { used: 1, total: 10 }, sickLeave: { used: 1, total: 10 }, biometricStatus: "enrolled", grossSalary: 60000, status: "on-leave" },
  { id: "EMP-006", name: "Roberto Lim", role: "employee", casualLeave: { used: 4, total: 10 }, sickLeave: { used: 2, total: 10 }, biometricStatus: "enrolled", grossSalary: 78000, status: "active" },
  { id: "EMP-007", name: "Patricia Tan", role: "employee", casualLeave: { used: 0, total: 10 }, sickLeave: { used: 0, total: 10 }, biometricStatus: "none", grossSalary: 58000, status: "active" },
  { id: "EMP-008", name: "Miguel Fernandez", role: "employee", casualLeave: { used: 6, total: 10 }, sickLeave: { used: 3, total: 10 }, biometricStatus: "enrolled", grossSalary: 70000, status: "active" },
  { id: "EMP-009", name: "Sofia Villanueva", role: "employee", casualLeave: { used: 2, total: 10 }, sickLeave: { used: 1, total: 10 }, biometricStatus: "enrolled", grossSalary: 82000, status: "active" },
  { id: "EMP-010", name: "Diego Ramos", role: "employee", casualLeave: { used: 3, total: 10 }, sickLeave: { used: 0, total: 10 }, biometricStatus: "pending", grossSalary: 68000, status: "active" },
  { id: "EMP-011", name: "Carmela Ong", role: "employee", casualLeave: { used: 1, total: 10 }, sickLeave: { used: 1, total: 10 }, biometricStatus: "enrolled", grossSalary: 90000, status: "active" },
  { id: "EMP-012", name: "Jorge Aquino", role: "extra", casualLeave: { used: 8, total: 10 }, sickLeave: { used: 5, total: 10 }, biometricStatus: "none", grossSalary: 52000, status: "inactive" },
];

export const attendanceData = {
  daily: [
    { label: "Mon", present: 10, late: 2, absent: 1 },
    { label: "Tue", present: 11, late: 1, absent: 0 },
    { label: "Wed", present: 9, late: 3, absent: 2 },
    { label: "Thu", present: 12, late: 0, absent: 0 },
    { label: "Fri", present: 8, late: 4, absent: 1 },
  ],
  weekly: [
    { label: "Week 1", present: 48, late: 8, absent: 4 },
    { label: "Week 2", present: 52, late: 5, absent: 2 },
    { label: "Week 3", present: 50, late: 10, absent: 3 },
    { label: "Week 4", present: 49, late: 6, absent: 5 },
  ],
  monthly: [
    { label: "Jan", present: 200, late: 25, absent: 12 },
    { label: "Feb", present: 195, late: 30, absent: 15 },
    { label: "Mar", present: 210, late: 20, absent: 10 },
    { label: "Apr", present: 205, late: 28, absent: 14 },
    { label: "May", present: 198, late: 35, absent: 18 },
    { label: "Jun", present: 212, late: 22, absent: 8 },
  ],
};

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat("en-PH", {
    style: "currency",
    currency: "PHP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

// Payroll request store (simple subscribe/notify pattern) used by manager/admin views
export type PayrollRequest = {
  id: string;
  employeeId: string;
  employeeName: string;
  amount: number;
  status: "processing" | "approved" | "rejected";
};

type Subscriber = () => void;

export const payrollRequestsStore = {
  data: [
    { id: "PR-001", employeeId: "EMP-001", employeeName: "Maria Santos", amount: 85000, status: "processing" as const },
  ] as PayrollRequest[],
  subs: new Set<Subscriber>(),
  get() {
    return this.data;
  },
  add(req: PayrollRequest) {
    this.data = [...this.data, req];
    this.notify();
  },
  update(id: string, status: PayrollRequest['status']) {
    this.data = this.data.map((r) => (r.id === id ? { ...r, status } : r));
    this.notify();
  },
  findByEmployee(empId: string) {
    return this.data.find((r) => r.employeeId === empId) || null;
  },
  subscribe(fn: Subscriber) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  },
  notify() {
    this.subs.forEach((s) => s());
  },
};
