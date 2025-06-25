import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import serviceAccount from "./serviceAccount.json" with { type: "json" };

import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
const port = 3000;

app.use(express.static(path.join(__dirname, 'public')));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();
// ------------------dishes--------------------------------------
app.get("/api/dishes", async (_, res) => {
  try {
    const dishesRef = db.collection("dishes");
    const snapshot = await dishesRef.get();

    if (snapshot.empty) {
      return res.status(404).json({
        message: "Страви не знайдено",
      });
    }

    const dishes = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      price: Number(doc.data().price)
    }));

    res.status(200).json(dishes);
  } catch (error) {
    console.error("Помилка при отриманні страв: ", error);
    res.status(500).json({
      message: "Помилка при отриманні страв",
      error: error.message,
    });
  }
});

// ------------------orders--------------------------------------

// Middleware для перевірки авторизації
const authenticateUser = async (req, res, next) => {
  try {
    const idToken = req.headers.authorization?.split("Bearer ")[1];
    if (!idToken) {
      return res.status(401).json({ message: "Неавторизований доступ" });
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("Помилка перевірки токена:", error);
    res.status(401).json({ message: "Неавторизований доступ" });
  }
};

app.get("/api/orders/:userId", authenticateUser, async (req, res) => {
  const { userId } = req.params;
  try {
    const ordersRef = db.collection("orders");
    const snapshot = await ordersRef.where("userId", "==", userId).get();

    const orders = await Promise.all(
      snapshot?.docs?.map(async (doc) => {
        const orderData = doc.data();
        const itemsSnap = await doc.ref.collection("items").get();
        const items = itemsSnap.docs.map((itemDoc) => itemDoc.data());
        return {
          orderId: doc.id,
          ...orderData,
          items,
        };
      })
    );

    return res.status(200).json(orders);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ message: "Помилка при завантаженні замовлень" });
  }
});

app.post("/api/orders", async (req, res) => {
  const { userId, order } = req.body;
  if (!userId || !order) {
    return res.status(400).json({ message: "Відсутні дані про користувача або замовлення" });
  }

  try {
    const orderRef = db.collection("orders").doc();
    await orderRef.set({
      userId,
      orderStartDatetime: order.orderStartDatetime,
      totalPrice: order.totalPrice,
      totalCount: order.totalCount,
      orderEndDatetime: order.orderEndDatetime,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const batch = db.batch();
    const itemsCol = orderRef.collection("items");
    order.items.forEach((item) => {
      const itemRef = itemsCol.doc();
      batch.set(itemRef, {
        ...item
      });
    });
    await batch.commit();

    res.status(201).json({ orderId: orderRef.id });
  } catch (error) {
    console.error("Помилка при збереженні замовлення:", error);
    res.status(500).json({ message: "Помилка при збереженні замовлення", error: error.message });
  }
});

app.patch(
  "/api/orders/:userId/:orderId/:dishId",
  authenticateUser,
  async (req, res) => {
    const { userId, orderId, dishId } = req.params;
    const { grade } = req.body;
    if (!userId || !orderId || !dishId || grade == null) {
      return res.status(400).json({ message: "Відсутні дані" });
    }
    try {
      const itemsCol = db.collection("orders").doc(orderId).collection("items");
      const snap = await itemsCol.where("id", "==", dishId).get();
      if (snap.empty) {
        return res.status(404).json({ message: "Страва не знайдена" });
      }
      await snap.docs[0].ref.update({ grade });
      return res.status(200).json({ message: "Оцінка оновлена" });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ message: "Помилка при оновленні оцінки" });
    }
  }
);

// ------------------authentication--------------------------------------

app.post("/api/signup", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Відсутні обов'язкові поля" });
    }

    // Створюємо користувача
    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

    // Створюємо customToken
    const customToken = await admin.auth().createCustomToken(userRecord.uid);

    // Отримуємо idToken через Firebase Auth REST API
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${serviceAccount.webApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: customToken,
        returnSecureToken: true,
      }),
    });

    const data = await response.json();
    res.status(201).json({
      message: "Користувача успішно створено",
      token: data.idToken,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
      },
    });
  } catch (error) {
    console.error("Помилка реєстрації:", error);
    if (error.code === "auth/email-already-in-use") {
      res.status(400).json({ message: "Обліковий запис з такою електронною поштою вже існує" });
    } else {
      res.status(500).json({ message: "Помилка при створенні користувача" });
    }
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Відсутні обов'язкові поля" });
    }

    // Отримуємо користувача за email
    const userRecord = await admin.auth().getUserByEmail(email);
    
    // Створюємо customToken
    const customToken = await admin.auth().createCustomToken(userRecord.uid);

    // Отримуємо idToken через Firebase Auth REST API
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${serviceAccount.webApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        token: customToken,
        returnSecureToken: true,
      }),
    });

    const data = await response.json();
    res.status(200).json({
      message: "Успішний вхід",
      token: data.idToken,
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
      },
    });
  } catch (error) {
    console.error("Помилка входу:", error);
    res.status(401).json({ message: "Неправильний email або пароль" });
  }
});

app.post("/api/logout", authenticateUser, async (req, res) => {
  try {
    await admin.auth().revokeRefreshTokens(req.user.uid);
    res.json({ message: "Успішний вихід" });
  } catch (error) {
    console.error("Помилка виходу:", error);
    res.status(500).json({ message: "Помилка при виході" });
  }
});

app.get("/api/user", authenticateUser, async (req, res) => {
  try {
    const userRecord = await admin.auth().getUser(req.user.uid);
    res.json({
      user: {
        uid: userRecord.uid,
        email: userRecord.email,
      },
    });
  } catch (error) {
    console.error("Помилка отримання користувача:", error);
    res.status(500).json({ message: "Помилка при отриманні даних користувача" });
  }
});

app.listen(port, () => {
  console.log(`Сервер запущено на http://localhost:${port}`);
});
