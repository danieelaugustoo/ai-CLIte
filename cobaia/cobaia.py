"""Ficheiro cobaia para testar a extensão CLIte-ai.

Não faz nada de útil: serve só para selecionar trechos e pedir ao Claude
para explicar, refatorar, encontrar bugs ou escrever testes.
"""

import json
import math
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, Iterable, List, Optional


# ---------------------------------------------------------------------------
# Utilitários de texto
# ---------------------------------------------------------------------------

def slugify(text):
    result = ""
    for ch in text.lower():
        if ch.isalnum():
            result = result + ch
        elif ch == " " or ch == "-" or ch == "_":
            if len(result) > 0 and result[-1] != "-":
                result = result + "-"
    if len(result) > 0 and result[-1] == "-":
        result = result[:-1]
    return result


def truncate(text, limit):
    if len(text) <= limit:
        return text
    else:
        return text[:limit - 3] + "..."


def count_words(text):
    words = text.split(" ")
    counts = {}
    for w in words:
        w = w.strip().lower()
        if w == "":
            continue
        if w in counts:
            counts[w] = counts[w] + 1
        else:
            counts[w] = 1
    return counts


def most_common_word(text):
    counts = count_words(text)
    best = None
    best_count = 0
    for word in counts:
        if counts[word] > best_count:
            best = word
            best_count = counts[word]
    return best


def is_palindrome(text):
    cleaned = ""
    for ch in text:
        if ch.isalnum():
            cleaned += ch.lower()
    return cleaned == cleaned[::-1]


def extract_emails(text):
    pattern = r"[\w.+-]+@[\w-]+\.[\w.]+"
    return re.findall(pattern, text)


def markdown_fence(code, lang="python"):
    """Devolve o código dentro de um bloco Markdown (com ``` no meio)."""
    fence = "```"
    return fence + lang + "\n" + code + "\n" + fence


# ---------------------------------------------------------------------------
# Matemática e estatística
# ---------------------------------------------------------------------------

def average(numbers):
    total = 0
    for n in numbers:
        total += n
    return total / len(numbers)


def median(numbers):
    ordered = sorted(numbers)
    middle = len(ordered) // 2
    if len(ordered) % 2 == 0:
        return (ordered[middle] + ordered[middle + 1]) / 2
    return ordered[middle]


def variance(numbers):
    mean = average(numbers)
    total = 0
    for n in numbers:
        total += (n - mean) ** 2
    return total / len(numbers)


def std_dev(numbers):
    return math.sqrt(variance(numbers))


def percentile(numbers, p):
    ordered = sorted(numbers)
    index = int(len(ordered) * p / 100)
    return ordered[index]


def clamp(value, low, high):
    if value < low:
        return low
    if value > high:
        return high
    return value


def fibonacci(n):
    if n <= 0:
        return []
    if n == 1:
        return [0]
    seq = [0, 1]
    while len(seq) < n:
        seq.append(seq[-1] + seq[-2])
    return seq


def is_prime(n):
    if n < 2:
        return False
    for i in range(2, n):
        if n % i == 0:
            return False
    return True


def primes_up_to(limit):
    found = []
    for n in range(2, limit + 1):
        if is_prime(n):
            found.append(n)
    return found


def gcd(a, b):
    while b != 0:
        a, b = b, a % b
    return a


def lcm(a, b):
    return a * b // gcd(a, b)


# ---------------------------------------------------------------------------
# Modelo de dados: produtos e stock
# ---------------------------------------------------------------------------

@dataclass
class Product:
    sku: str
    name: str
    price: float
    quantity: int = 0
    tags: List[str] = field(default_factory=list)

    def total_value(self):
        return self.price * self.quantity

    def add_tag(self, tag):
        if tag not in self.tags:
            self.tags.append(tag)

    def to_dict(self):
        return {
            "sku": self.sku,
            "name": self.name,
            "price": self.price,
            "quantity": self.quantity,
            "tags": self.tags,
        }


class Inventory:
    def __init__(self):
        self.products: Dict[str, Product] = {}
        self.history = []

    def add(self, product):
        if product.sku in self.products:
            existing = self.products[product.sku]
            existing.quantity += product.quantity
        else:
            self.products[product.sku] = product
        self.history.append(("add", product.sku, product.quantity))

    def remove(self, sku, quantity):
        product = self.products[sku]
        if product.quantity < quantity:
            raise ValueError("stock insuficiente para " + sku)
        product.quantity -= quantity
        self.history.append(("remove", sku, quantity))
        if product.quantity == 0:
            del self.products[sku]

    def find_by_tag(self, tag):
        result = []
        for product in self.products.values():
            if tag in product.tags:
                result.append(product)
        return result

    def total_value(self):
        total = 0
        for product in self.products.values():
            total += product.total_value()
        return total

    def cheapest(self):
        best = None
        for product in self.products.values():
            if best is None or product.price < best.price:
                best = product
        return best

    def most_expensive(self):
        best = None
        for product in self.products.values():
            if best is None or product.price > best.price:
                best = product
        return best

    def low_stock(self, threshold=5):
        return [p for p in self.products.values() if p.quantity < threshold]

    def report(self):
        lines = []
        lines.append("RELATORIO DE STOCK")
        lines.append("=" * 30)
        for sku in sorted(self.products):
            p = self.products[sku]
            lines.append(sku + " | " + p.name + " | " + str(p.quantity) + " | " + str(p.price))
        lines.append("=" * 30)
        lines.append("Total: " + str(self.total_value()))
        return "\n".join(lines)

    def save(self, path):
        data = [p.to_dict() for p in self.products.values()]
        f = open(path, "w")
        json.dump(data, f)
        f.close()

    def load(self, path):
        f = open(path, "r")
        data = json.load(f)
        f.close()
        for item in data:
            self.add(Product(**item))


# ---------------------------------------------------------------------------
# Encomendas
# ---------------------------------------------------------------------------

@dataclass
class OrderLine:
    sku: str
    quantity: int
    unit_price: float

    def subtotal(self):
        return self.quantity * self.unit_price


class Order:
    STATUSES = ["new", "paid", "shipped", "delivered", "cancelled"]

    def __init__(self, order_id, customer):
        self.order_id = order_id
        self.customer = customer
        self.lines: List[OrderLine] = []
        self.status = "new"
        self.created_at = datetime.now()

    def add_line(self, sku, quantity, unit_price):
        self.lines.append(OrderLine(sku, quantity, unit_price))

    def subtotal(self):
        total = 0
        for line in self.lines:
            total += line.subtotal()
        return total

    def discount(self):
        total = self.subtotal()
        if total > 1000:
            return total * 0.15
        elif total > 500:
            return total * 0.10
        elif total > 100:
            return total * 0.05
        return 0

    def tax(self):
        return (self.subtotal() - self.discount()) * 0.23

    def total(self):
        return self.subtotal() - self.discount() + self.tax()

    def advance(self):
        index = self.STATUSES.index(self.status)
        if self.status in ("delivered", "cancelled"):
            raise ValueError("encomenda já terminada")
        self.status = self.STATUSES[index + 1]

    def cancel(self):
        if self.status == "delivered":
            raise ValueError("não se pode cancelar uma encomenda entregue")
        self.status = "cancelled"

    def age(self):
        return datetime.now() - self.created_at


def orders_by_customer(orders: Iterable[Order]):
    grouped = defaultdict(list)
    for order in orders:
        grouped[order.customer].append(order)
    return grouped


def revenue_by_customer(orders):
    result = {}
    for order in orders:
        if order.status == "cancelled":
            continue
        if order.customer in result:
            result[order.customer] += order.total()
        else:
            result[order.customer] = order.total()
    return result


def best_customer(orders):
    revenue = revenue_by_customer(orders)
    best = None
    best_value = 0
    for customer, value in revenue.items():
        if value > best_value:
            best = customer
            best_value = value
    return best


def overdue_orders(orders, days=7):
    limit = timedelta(days=days)
    late = []
    for order in orders:
        if order.status in ("new", "paid") and order.age() > limit:
            late.append(order)
    return late


# ---------------------------------------------------------------------------
# Ficheiros e configuração
# ---------------------------------------------------------------------------

def read_lines(path):
    f = open(path)
    lines = f.readlines()
    return [line.strip() for line in lines]


def parse_config(lines):
    config = {}
    for line in lines:
        if line == "" or line.startswith("#"):
            continue
        key, value = line.split("=")
        config[key.strip()] = value.strip()
    return config


def load_config(path):
    if not os.path.exists(path):
        return {}
    return parse_config(read_lines(path))


def get_int(config, key, default=0):
    value = config.get(key)
    if value is None:
        return default
    return int(value)


def get_bool(config, key, default=False):
    value = config.get(key)
    if value is None:
        return default
    return value.lower() in ("1", "true", "yes", "sim")


def list_python_files(folder):
    found = []
    for root, dirs, files in os.walk(folder):
        for name in files:
            if name.endswith(".py"):
                found.append(os.path.join(root, name))
    return found


def count_lines_in_folder(folder):
    total = 0
    for path in list_python_files(folder):
        total += len(read_lines(path))
    return total


# ---------------------------------------------------------------------------
# Cache simples com expiração
# ---------------------------------------------------------------------------

class Cache:
    def __init__(self, ttl_seconds=60):
        self.ttl = ttl_seconds
        self.data = {}

    def set(self, key, value):
        self.data[key] = (value, datetime.now())

    def get(self, key):
        if key not in self.data:
            return None
        value, stored_at = self.data[key]
        if (datetime.now() - stored_at).seconds > self.ttl:
            del self.data[key]
            return None
        return value

    def size(self):
        return len(self.data)

    def clear(self):
        self.data = {}


def memoize(func):
    cache = Cache(ttl_seconds=300)

    def wrapper(*args):
        cached = cache.get(args)
        if cached is not None:
            return cached
        result = func(*args)
        cache.set(args, result)
        return result

    return wrapper


@memoize
def slow_square(n):
    total = 0
    for _ in range(n):
        total += n
    return total


# ---------------------------------------------------------------------------
# Ponto de entrada de demonstração
# ---------------------------------------------------------------------------

def demo():
    inventory = Inventory()
    inventory.add(Product("A1", "Caneta", 1.5, 100, ["papelaria"]))
    inventory.add(Product("B2", "Caderno", 4.0, 3, ["papelaria"]))
    inventory.add(Product("C3", "Mochila", 39.9, 8, ["escola", "mala"]))

    order = Order(1, "Ana")
    order.add_line("A1", 10, 1.5)
    order.add_line("C3", 2, 39.9)
    order.advance()

    print(inventory.report())
    print("Total da encomenda:", order.total())
    print("Palavra mais comum:", most_common_word("um dois dois tres tres tres"))
    print("Fibonacci:", fibonacci(10))
    print("Primos:", primes_up_to(30))
    print("Mediana:", median([5, 1, 9, 3]))


if __name__ == "__main__":
    demo()
