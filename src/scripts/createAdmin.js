require("dotenv").config();

const readline = require("readline");
const bcrypt = require("bcrypt");
const prisma = require("../config/prisma");
const { validateNewUser } = require("../controllers/userController");

function askVisible(question) {
  return new Promise((resolve) => {
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    prompt.question(question, (answer) => {
      prompt.close();
      resolve(answer.trim());
    });
  });
}

function askHidden(question) {
  if (!process.stdin.isTTY) {
    return askVisible(question);
  }

  return new Promise((resolve, reject) => {
    let answer = "";
    const input = process.stdin;
    const output = process.stdout;

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    output.write(question);

    function cleanUp() {
      input.removeListener("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    }

    function onKeypress(character, key) {
      if (key.ctrl && key.name === "c") {
        cleanUp();
        output.write("\n");
        reject(new Error("Administrator creation cancelled"));
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        cleanUp();
        output.write("\n");
        resolve(answer);
        return;
      }

      if (key.name === "backspace") {
        if (answer.length > 0) {
          answer = answer.slice(0, -1);
          output.write("\b \b");
        }
        return;
      }

      if (character && !key.ctrl && !key.meta) {
        answer += character;
        output.write("*");
      }
    }

    input.on("keypress", onKeypress);
  });
}

async function createFirstAdmin() {
  const existingAdmin = await prisma.user.findFirst({
    where: { role: "ADMIN" },
    select: { id: true },
  });

  if (existingAdmin) {
    throw new Error(
      "An administrator already exists. Use the admin API to create additional users."
    );
  }

  const fullName = await askVisible("Administrator full name: ");
  const username = (await askVisible("Administrator username: ")).toLowerCase();
  const password = await askHidden("Administrator password: ");
  const passwordConfirmation = await askHidden("Confirm password: ");

  if (password !== passwordConfirmation) {
    throw new Error("The passwords do not match");
  }

  const validationError = validateNewUser({
    fullName,
    username,
    password,
    role: "ADMIN",
  });

  if (validationError) {
    throw new Error(validationError);
  }

  const passwordHash = await bcrypt.hash(password, 12);

  const admin = await prisma.$transaction(async (transaction) => {
    const user = await transaction.user.create({
      data: {
        fullName,
        username,
        passwordHash,
        role: "ADMIN",
      },
      select: {
        id: true,
        fullName: true,
        username: true,
        role: true,
      },
    });

    await transaction.auditLog.create({
      data: {
        userId: user.id,
        action: "CREATE_INITIAL_ADMIN",
        entityType: "USER",
        entityId: user.id,
      },
    });

    return user;
  });

  console.log(`Administrator "${admin.username}" created successfully.`);
}

createFirstAdmin()
  .catch((error) => {
    console.error(`Unable to create administrator: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
