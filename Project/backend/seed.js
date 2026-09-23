import { MongoClient } from "mongodb";
import dotenv from "dotenv";

dotenv.config();

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error("MONGODB_URI is not defined in backend/.env");
  process.exit(1);
}

const people = [
  ["Maria Santos", "maria.santos@example.com", "regular"],
  ["Juan Dela Cruz", "juan.delacruz@example.com", "regular"],
  ["Ana Reyes", "ana.reyes@example.com", "regular"],
  ["Carlos Mendoza", "carlos.mendoza@example.com", "regular"],
  ["Liza Garcia", "liza.garcia@example.com", "regular"],
  ["Roberto Lim", "roberto.lim@example.com", "extra"],
  ["Patricia Tan", "patricia.tan@example.com", "extra"],
  ["Miguel Fernandez", "miguel.fernandez@example.com", "extra"],
  ["Sofia Villanueva", "sofia.villanueva@example.com", "extra"],
  ["Diego Ramos", "diego.ramos@example.com", "extra"],
];

const employees = people.map(([name, email, role], index) => ({
  id: `EMP-${String(index + 1).padStart(3, "0")}`,
  name,
  email,
  phone: "",
  address: "",
  role,
  hourlyRate: role === "regular" ? 50 : 40,
  grossSalary: 0,
  status: "active",
  casualLeave: { total: 10, used: 0 },
  sickLeave: { total: 10, used: 0 },
  biometricStatus: "none",
  identifiers: [
    { type: "SSS", value: `34-${String(1200000 + index * 7913).padStart(7, "0")}-${index}`, amount: 100 + index * 15 },
    { type: index % 2 === 0 ? "PhilHealth" : "Pag-IBIG", value: `${String(120000000000 + index * 18347)}`, amount: 75 + index * 10 },
  ],
  createdAt: new Date(),
  updatedAt: new Date(),
}));

const leaveRequests = [
  { id: "LR-001", employeeId: "EMP-001", employeeName: "Maria Santos", role: "Regular", leaveType: "Annual Leave", startDate: "2026-08-10", endDate: "2026-08-12", totalDays: 3, reason: "Family commitment outside the city.", status: "pending", initials: "MS" },
  { id: "LR-002", employeeId: "EMP-003", employeeName: "Ana Reyes", role: "Regular", leaveType: "Sick Leave", startDate: "2026-08-05", endDate: "2026-08-06", totalDays: 2, reason: "Medical consultation and recovery.", status: "pending", initials: "AR" },
  { id: "LR-003", employeeId: "EMP-006", employeeName: "Roberto Lim", role: "Extra", leaveType: "Personal Leave", startDate: "2026-08-14", endDate: "2026-08-14", totalDays: 1, reason: "Important personal appointment.", status: "pending", initials: "RL" },
  { id: "LR-004", employeeId: "EMP-008", employeeName: "Miguel Fernandez", role: "Extra", leaveType: "Annual Leave", startDate: "2026-08-20", endDate: "2026-08-22", totalDays: 3, reason: "Planned family vacation.", status: "pending", initials: "MF" },
];

async function seedEmployees() {
  const client = new MongoClient(uri);
  try {
    console.log("Connecting to MongoDB...");
    await client.connect();
    const db = client.db();

    // This seed intentionally replaces employees only. Other collections are preserved.
    await db.collection("employees").deleteMany({});
    await db.collection("employees").insertMany(employees);
    await db.collection("leave_requests").deleteMany({});
    await db.collection("leave_requests").insertMany(leaveRequests);

    const counts = await db.collection("employees").aggregate([
      { $group: { _id: "$role", count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray();
    console.log(`Seeded ${employees.length} employees successfully.`);
    console.log(`Seeded ${leaveRequests.length} leave requests successfully.`);
    for (const item of counts) console.log(`${item._id}: ${item.count}`);
  } catch (error) {
    console.error("Employee seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await client.close();
  }
}

seedEmployees();
