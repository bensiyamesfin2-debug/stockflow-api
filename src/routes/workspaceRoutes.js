const express = require("express");
const controller = require("../controllers/workspaceController");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.use(authenticate);

router.get("/", controller.getWorkspace);
router.patch("/settings", controller.updateSettings);
router.patch("/preferences", controller.updatePreferences);
router.get("/search", controller.globalSearch);
router.post("/delivery-link", controller.createDeliveryLink);

router.get("/notes", controller.listNotes);
router.post("/notes", controller.createNote);
router.patch("/notes/:id", controller.updateNote);
router.delete("/notes/:id", controller.deleteNote);

router.get("/calendar", controller.listCalendarEvents);
router.post("/calendar", controller.createCalendarEvent);
router.patch("/calendar/:id", controller.updateCalendarEvent);
router.delete("/calendar/:id", controller.deleteCalendarEvent);

router.get("/favorites", controller.listFavorites);
router.post("/favorites", controller.createFavorite);
router.delete("/favorites/:id", controller.deleteFavorite);

router.get("/invoice-templates", controller.listTemplates);
router.post("/invoice-templates", controller.createTemplate);
router.patch("/invoice-templates/:id", controller.updateTemplate);
router.delete("/invoice-templates/:id", controller.deleteTemplate);

router.get("/attachments", controller.listAttachments);
router.post("/attachments", controller.createAttachment);
router.get("/attachments/:id", controller.getAttachment);
router.delete("/attachments/:id", controller.deleteAttachment);

module.exports = router;
