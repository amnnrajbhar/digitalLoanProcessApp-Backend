const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const dotenv = require("dotenv");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { GoogleGenerativeAI } = require("@google/generative-ai");

dotenv.config();
const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI;
const SECRET_KEY = process.env.JWT_SECRET || "fallback_secret";
const GOOGLE_AI_API_KEY = process.env.GOOGLE_AI_API_KEY;

if (!MONGO_URI || !SECRET_KEY || !GOOGLE_AI_API_KEY) {
  console.error(
    "Environment variables are missing. Please check your .env file."
  );
  process.exit(1);
}

// Google AI setup
const genAI = new GoogleGenerativeAI(GOOGLE_AI_API_KEY);

// Middleware
app.use(cors());
app.use(bodyParser.json());

// Connect to MongoDB
mongoose
  .connect(MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch((err) => console.error("MongoDB connection error:", err));

// User Schema
const UserSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true },
  password: String,
});
const User = mongoose.model("User", UserSchema);

// Register Route
app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ name, email, password: hashedPassword });
    await newUser.save();

    res.json({ message: "Registration successful" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Registration failed, please try again" });
  }
});
// Get all users route
app.get("/users", async (req, res) => {
  try {
    const users = await User.find(); // Fetch all users from the database
    res.json(users); // Return the users as JSON
  } catch (error) {
    res.status(500).json({ error: "Failed to retrieve users" });
  }
});

// Login Route
app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    // Find user by email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Compare the entered password with the hashed password in DB
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Invalid email or password" });
    }

    // Generate JWT Token
    const token = jwt.sign(
      { userId: user._id, email: user.email },
      SECRET_KEY,
      { expiresIn: "1h" }
    );

    res.json({
      message: "Login successful",
      token,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Login failed, please try again" });
  }
});

// AI Loan Eligibility Route
app.post("/eligibility", async (req, res) => {
  try {
    const { income, creditScore, employmentStatus, loanAmount } = req.body;

    if (!income || !creditScore || !employmentStatus || !loanAmount) {
      return res
        .status(400)
        .json({ error: "All fields are required for eligibility check" });
    }

    const aiPrompt = `
Given the following details:
- Credit Score: ${creditScore}
- Monthly Income: ₹${income}
- Loan Amount: ₹${loanAmount}
- Employment Status: ${employmentStatus}

Based on Indian bank criteria, respond with only **"Eligible"** or **"Not Eligible"**.
`;

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const result = await model.generateContent(aiPrompt);
    const responseText = result.response.text();

    res.json({ result: responseText });
  } catch (error) {
    console.error(error);
    res
      .status(500)
      .json({ error: "Failed to process AI request, please try again" });
  }
});

function authenticateToken(req, res, next) {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Access Denied" });

  jwt.verify(token, SECRET_KEY, (err, decoded) => {
    if (err) return res.status(403).json({ error: "Invalid Token" });
    req.user = decoded;
    next();
  });
}

// Loan Schema
const LoanSchema = new mongoose.Schema({
  amount: { type: String, required: true },
  tenure: { type: String, required: true },
  income: { type: String, required: true },
  purpose: { type: String, required: true },
  status: { type: String, default: "Pending" }, // Default status
});

const Loan = mongoose.model("Loan", LoanSchema);

// Apply Loan API
app.post("/apply-loan", authenticateToken, async (req, res) => {
  try {
    const loan = new Loan(req.body);
    await loan.save();
    res.json({ message: "Loan Application Submitted", loan });
  } catch (error) {
    res.status(500).json({ error: "Failed to apply for a loan" });
  }
});

// Get Loan Status API
app.get("/loan-status", authenticateToken, async (req, res) => {
  try {
    const loans = await Loan.find();
    res.json({ loans });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch loans" });
  }
});

// Admin Approve/Reject Loan API
app.put("/loan-action/:id", authenticateToken, async (req, res) => {
  try {
    // Only allow admin users to approve or reject loans
    // if (req.user.role !== 'admin') {
    //     return res.status(403).json({ error: "You are not authorized to perform this action" });
    // }

    const loanId = req.params.id;
    const { action } = req.body;

    // Validate action
    if (!action || (action !== "approve" && action !== "reject")) {
      return res
        .status(400)
        .json({ error: "Invalid action. Use 'approve' or 'reject'." });
    }

    // Determine the new status
    const newStatus = action === "approve" ? "Approved" : "Rejected";

    // Check if loan ID is valid
    if (!mongoose.Types.ObjectId.isValid(loanId)) {
      return res.status(400).json({ error: "Invalid loan ID" });
    }

    // Update loan status
    const loan = await Loan.findByIdAndUpdate(
      loanId,
      { status: newStatus },
      { new: true }
    );

    if (!loan) {
      return res.status(404).json({ error: "Loan not found" });
    }

    res.json({ message: `Loan ${newStatus.toLowerCase()} successfully`, loan });
  } catch (error) {
    console.error("Error updating loan status:", error);
    res.status(500).json({ error: "Failed to update loan status" });
  }
});

// Home route
app.get("/", (req, res) => {
  res.send("Loan Eligibility AI & User Auth API is running...");
});

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
