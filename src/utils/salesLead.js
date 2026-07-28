const ALLOWED_STATUSES = new Set(["NEW", "CONTACTED", "CLOSED"]);
const ALLOWED_INTERESTS = new Set([
  "STOCKFLOW",
  "CUSTOM_BUSINESS_SYSTEM",
  "WEBSITE_PORTAL",
  "MOBILE_APP",
  "AUTOMATION_REPORTING",
  "OTHER",
]);
const PHONE_PATTERN = /^[+0-9][0-9\s()-]{6,29}$/;

function cleanText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeSalesLead(input = {}) {
  const fullName = cleanText(input.fullName);
  const businessName = cleanText(input.businessName);
  const phone = cleanText(input.phone);
  const interest = cleanText(input.interest || "STOCKFLOW").toUpperCase();
  const city = cleanText(input.city);
  const message = String(input.message || "").trim();
  const errors = [];

  if (fullName.length < 2 || fullName.length > 100) {
    errors.push("Full name must be between 2 and 100 characters");
  }
  if (businessName.length < 2 || businessName.length > 150) {
    errors.push("Business name must be between 2 and 150 characters");
  }
  if (!PHONE_PATTERN.test(phone)) {
    errors.push("Enter a valid phone number");
  }
  if (!ALLOWED_INTERESTS.has(interest)) {
    errors.push("Choose a valid project type");
  }
  if (city.length > 100) {
    errors.push("City must be 100 characters or fewer");
  }
  if (message.length > 1000) {
    errors.push("Message must be 1,000 characters or fewer");
  }

  if (errors.length) return { errors };
  return {
    data: {
      fullName,
      businessName,
      phone,
      interest,
      city: city || null,
      message: message || null,
    },
  };
}

function normalizeLeadStatus(value) {
  const status = cleanText(value).toUpperCase();
  return ALLOWED_STATUSES.has(status) ? status : null;
}

module.exports = {
  normalizeSalesLead,
  normalizeLeadStatus,
};
